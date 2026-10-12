import { test } from "node:test";
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseTransport } from "../src/supabase";
test("Supabase adapter subscribes to its document and removes listeners on disposal", async () => {
  let callback: (payload: unknown) => void = () => {},
    statusCallback: (status: string) => void = () => {},
    removed = false,
    filter: unknown;
  const channel = {
    on(_event: string, f: unknown, fn: typeof callback) {
      filter = f;
      callback = fn;
      return channel;
    },
    subscribe(fn: typeof statusCallback) {
      statusCallback = fn;
      return channel;
    },
  };
  const client = {
    channel: () => channel,
    removeChannel: async (c: unknown) => {
      assert.equal(c, channel);
      removed = true;
    },
  } as unknown as SupabaseClient;
  const transport = supabaseTransport(client, "example");
  const received: unknown[] = [],
    statuses: boolean[] = [];
  const stop = transport.subscribe(
    (s) => received.push(s),
    (s) => statuses.push(s),
  );
  assert.deepEqual(filter, {
    event: "INSERT",
    schema: "public",
    table: "dv_changes",
    filter: "document_id=eq.example",
  });
  statusCallback("SUBSCRIBED");
  callback({ new: { revision: 3, at: "now", operations: [] } });
  statusCallback("CHANNEL_ERROR");
  assert.deepEqual(statuses, [true, false]);
  assert.equal(received.length, 1);
  stop();
  callback({ new: { revision: 4 } });
  statusCallback("SUBSCRIBED");
  assert.equal(received.length, 1);
  assert.equal(statuses.length, 2);
  assert.ok(removed);
});

test("database reads and writes have abort deadlines", async () => {
  const signals: AbortSignal[] = [];
  const query = {
    select() {
      return query;
    },
    eq() {
      return query;
    },
    abortSignal(signal: AbortSignal) {
      signals.push(signal);
      return query;
    },
    then(resolve: (v: unknown) => unknown) {
      return Promise.resolve({
        data: { snapshot: { revision: 1, data: {} } },
        error: null,
      }).then(resolve);
    },
  };
  const client = {
    rpc: () => query,
  } as unknown as SupabaseClient;
  const transport = supabaseTransport(client, "example");
  await transport.read();
  await transport.commit("receipt", []);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
  assert.notEqual(signals[0], signals[1]);
});
test("a write names the person the visitor says they are", async () => {
  let sent: any;
  const query = {
    abortSignal: () => query,
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: { change: {} }, error: null }).then(resolve),
  };
  const client = {
    rpc(_name: string, args: unknown) {
      sent = args;
      return query;
    },
  } as unknown as SupabaseClient;
  let me: string | undefined = "ada";
  const transport = supabaseTransport(client, "example", undefined, () => me);
  await transport.commit("r", []);
  assert.equal(sent.actor, "ada");
  me = undefined;
  await transport.commit("r", []);
  assert.equal(sent.actor, null);
});
