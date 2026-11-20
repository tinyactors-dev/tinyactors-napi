// The room chart's helpers (room.scxml): each takes what it reads.

/** The sender's key: its address from the "#" on. Core writes one sender's
 * origin in two forms, #_scxml_<n> and tinyactors://chat/#_scxml_<n>
 * (docs/guide/missing-actors.md, "Keying a table by the sender"). */
function sender(origin) {
  return origin.slice(origin.indexOf('#'));
}

function workspaceAddress(workspace) {
  return `tinyactors://chat/@workspace.${workspace}`;
}

function message(room, members, event) {
  return { room, user: members[sender(event.origin)], text: event.data.text };
}

function stored(workspace, room, members, event) {
  return { workspace, ...message(room, members, event) };
}

/** The history with `item` added, its last 200 entries. */
function remember(history, item) {
  return [...history.slice(-199), item];
}

/** What a member who joins is shown. */
function recent(history) {
  return history.slice(-50);
}

/** The members' users, each once, sorted. */
function users(members) {
  return [...new Set(Object.values(members))].sort();
}

function withEntry(table, key, value) {
  return { ...table, [key]: value };
}

function withoutEntry(table, key) {
  const { [key]: _, ...rest } = table;
  return rest;
}

function withoutAll(table, gone) {
  return Object.fromEntries(Object.entries(table).filter(([key]) => !gone.includes(key)));
}

function withoutUser(table, user) {
  return Object.fromEntries(Object.entries(table).filter(([, value]) => value !== user));
}
