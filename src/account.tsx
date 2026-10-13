// What the menu at the top right holds: signing in with this device's
// passcode, or for someone signed in, setting one, the admin's sign-in links,
// and signing out.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Entity } from "./model";
import type { Session, SessionState, SignInLink } from "./session";
const day = (stamp: string) =>
  new Date(stamp).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
function Passcode({
  action,
  onSubmit,
}: {
  action: string;
  onSubmit: (passcode: string) => Promise<void>;
}) {
  const [value, setValue] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || !value) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(value);
      setValue("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="dv-account-form">
      <input
        type="password"
        autoFocus
        aria-label="Passcode"
        placeholder="Passcode"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
      <button type="button" disabled={busy || !value} onClick={submit}>
        {action}
      </button>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
function Links({
  session,
  people,
  prefix,
}: {
  session: Session;
  people: Entity[];
  prefix: (person: Entity) => ReactNode;
}) {
  const [links, setLinks] = useState<SignInLink[]>(),
    [made, setMade] = useState<{ person: string; url: string }>(),
    [copied, setCopied] = useState(false),
    [error, setError] = useState("");
  const run = (work: () => Promise<void>) => {
    setError("");
    work()
      .then(async () => setLinks(await session.links()))
      .catch((e) => setError((e as Error).message));
  };
  useEffect(() => run(async () => {}), []);
  // A fresh link is brought into view, above the long list of people.
  const fresh = useRef<HTMLSpanElement>(null);
  useEffect(() => fresh.current?.scrollIntoView({ block: "nearest" }), [made]);
  const name = (id: string) =>
    String(people.find((p) => p.id === id)?.name ?? id);
  const live = (links ?? []).filter((l) => !l.revoked_at);
  return (
    <>
      {made && (
        <span className="dv-account-form" ref={fresh}>
          <span>
            Send this to {name(made.person)}. It is shown once, and works until
            you revoke it.
          </span>
          <input
            readOnly
            aria-label="Sign-in link"
            value={made.url}
            onFocus={(e) => e.target.select()}
          />
          <button
            type="button"
            onClick={() =>
              navigator.clipboard
                .writeText(made.url)
                .then(() => setCopied(true))
                .catch(() => setError("Could not copy; select it instead."))
            }
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </span>
      )}
      <span className="dv-menu-title">New sign-in link for</span>
      {people.map((p) => (
        <button
          type="button"
          key={p.id}
          onClick={() =>
            run(async () => {
              setCopied(false);
              setMade({ person: p.id, url: await session.createLink(p.id) });
            })
          }
        >
          {prefix(p)}
          {String(p.name)}
        </button>
      ))}
      <span className="dv-menu-title">
        {links ? (live.length ? "Links in use" : "No links yet") : "Loading…"}
      </span>
      {live.map((l) => (
        <span className="dv-account-link" key={l.id}>
          <span>
            {name(l.person)} · made {day(l.created_at)}
            {l.last_used_at ? ` · used ${day(l.last_used_at)}` : " · unused"}
          </span>
          <button
            type="button"
            aria-label={`Revoke the link for ${name(l.person)} made ${day(l.created_at)}`}
            onClick={() => run(() => session.revokeLink(l.id))}
          >
            Revoke
          </button>
        </span>
      ))}
      {error && (
        <span className="dv-account-form" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
export function Account({
  session,
  state,
  people,
  prefix,
  close,
}: {
  session: Session;
  state: SessionState;
  people: Entity[];
  prefix: (person: Entity) => ReactNode;
  close: () => void;
}) {
  const [panel, setPanel] = useState<"passcode" | "links" | "saved">();
  if (!state.person)
    return (
      <>
        <Passcode
          action="Sign in"
          onSubmit={(code) => session.signIn(code).then(close)}
        />
        <button type="button" onClick={() => void session.forget().then(close)}>
          Forget this device
        </button>
      </>
    );
  return (
    <>
      <button
        type="button"
        aria-expanded={panel === "passcode"}
        onClick={() => setPanel(panel === "passcode" ? undefined : "passcode")}
      >
        {state.remembered === state.person
          ? "Change this device’s passcode"
          : "Set a passcode for this device"}
      </button>
      {panel === "passcode" && (
        <Passcode
          action="Save"
          onSubmit={async (code) => {
            await session.setPasscode(code);
            setPanel("saved");
          }}
        />
      )}
      {panel === "saved" && (
        <span className="dv-account-form" role="status">
          Saved. If you are signed out, this device can sign in with it.
        </span>
      )}
      {state.admin && (
        <button
          type="button"
          aria-expanded={panel === "links"}
          onClick={() => setPanel(panel === "links" ? undefined : "links")}
        >
          Sign-in links
        </button>
      )}
      {panel === "links" && (
        <Links session={session} people={people} prefix={prefix} />
      )}
      <button type="button" onClick={() => void session.signOut().then(close)}>
        Sign out
      </button>
    </>
  );
}
