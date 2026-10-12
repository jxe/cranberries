-- A document as it was stored before 004, to check the upgrade.
insert into dv_documents(id,config,data,public_read,public_write) values ('legacy',
  '{"title":"Legacy","schema":{"person":{"name":"text"},"task":{"name":"text","leads":{"many":"person","label":"lead"},"status":{"choices":["Open","Done"],"colors":{"Open":"#111"},"bullet":true},"note":"longtext"}},"collection":"task","line":["name"],"views":[{"label":"All"}],"labels":{"person":"lead"},"fixed":["person"]}',
  '{"person":[{"id":"p","name":"Person"}],"task":[{"id":"t","name":"Task","leads":["p"],"status":"Open","note":""}]}',
  true, true);
