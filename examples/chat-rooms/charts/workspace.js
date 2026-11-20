// The workspace chart's helpers (workspace.scxml). A chart-level script's
// functions are the chart's, made once and shared by every workspace: they
// see no workspace's variables by name, so each takes what it reads.

// A room's name is lowercase letters, digits and "-": with the workspace's
// id (the same characters) and "." between them, the room's actor name,
// room.<workspace>.<name>, needs no percent-encoding in an address.
function validName(name) {
  return typeof name === 'string' && /^[a-z0-9-]{1,64}$/.test(name);
}

/** Why `event` (a room.create) is refused, or null when it is not. */
function refusal(owners, rooms, creating, event) {
  const { user, name } = event.data;
  if (!owners.includes(user)) return 'not an owner';
  if (!validName(name)) return 'invalid name';
  if (name in rooms || Object.values(creating).some((pending) => pending.name === name)) return 'exists';
  return null;
}

/** What the Spawner is sent: the room's chart, its actor name, its params. */
function roomSpawn(workspace, event) {
  const { name } = event.data;
  return { chart: 'room', name: `room.${workspace}.${name}`, params: { workspace, name } };
}

function withEntry(table, key, value) {
  return { ...table, [key]: value };
}

function withoutEntry(table, key) {
  const { [key]: _, ...rest } = table;
  return rest;
}
