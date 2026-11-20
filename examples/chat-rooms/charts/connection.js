// The connection chart's helpers (connection.scxml).
//
// The naming convention: an actor's name is its kind and its ids joined
// by ".", each id of lowercase letters, digits and "-" (workspace.js
// checks a room's name). Those are all characters an address takes as
// they are, so the address is the name written after "@", with no
// percent-encoding anywhere it is written.

function roomAddress(workspace, room) {
  return `tinyactors://chat/@room.${workspace}.${room}`;
}

function workspaceAddress(workspace) {
  return `tinyactors://chat/@workspace.${workspace}`;
}

function added(items, item) {
  return items.includes(item) ? items : [...items, item];
}

function removed(items, item) {
  return items.filter((each) => each !== item);
}

function frame(event, data) {
  return { event, data };
}
