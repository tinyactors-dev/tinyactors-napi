'use strict';

// The stack of a thread, innermost first: the unit the actor runs next and
// the <if> and <foreach> around it, the block (`onentry of busy`, a
// transition's content), the microstep, and the macrostep with its event.
// The top frame is where the actor stands, as a debugger's current line is:
// what a step runs next (core ADR 0083). Between two microsteps that is
// transition selection. An actor between macrosteps has one frame that says
// where it rests.
//
// Where the actor stands comes from inspection, so an actor that paused
// before the debugger attached has a position too. The transitions of its
// microstep come from the trace spans the session read, and are left out
// when it did not see them. Each frame's place in the JavaScript that wrote
// the chart comes from its source spans (core ADR 0085), when it has them.

/** The active states no other active state is inside of. */
function leaves(view, labels) {
  const states = labels.states(view.definitionID);
  const parentOf = (name) => {
    const parent = states.find((state) => state.name === name)?.parent;
    return parent === undefined || parent === null ? undefined : states[parent]?.name;
  };
  const parents = new Set(view.activeStates.map(parentOf));
  return view.activeStates.filter((state) => !parents.has(state));
}

/**
 * [{ name, hint, place, macrostep }] for a thread. `view` is its inspection
 * or undefined when it is gone; `labels` names compiled IDs; `sources`
 * places them; `seen` is { macrostep, microstep } from the spans, or
 * undefined; `note` is added to an actor at rest (the mail waiting for it).
 */
function frames({ view, labels, sources, seen, note }) {
  if (view === undefined) {
    return [{ name: 'gone', hint: 'label' }];
  }
  const definition = view.definitionID;
  const statePlace = (name) => sources.place(definition, 'state', labels.stateID(definition, name));
  if (view.residency === 'done') {
    return [{ name: `done in ${view.finalState ?? 'its final state'}`, hint: 'normal',
              place: view.finalState === null ? undefined : statePlace(view.finalState) }];
  }
  if (!view.macrostepInProgress) {
    const at = leaves(view, labels);
    return [{ name: `idle in ${at.join(' ') || 'no state'}${note ? ` (${note})` : ''}`, hint: 'normal',
              place: at.length === 0 ? undefined : statePlace(at[0]) }];
  }
  if (view.step.macrostep === 0) {
    return [{ name: view.currentEvent === null ? 'about to start (its bootstrap has not run)'
      : `about to take ${view.currentEvent.name} (before transition selection)`, hint: 'normal' }];
  }
  return [...unitFrames(view, labels, sources), ...stepFrames(view, seen, sources)];
}

function unitFrames(view, labels, sources) {
  const { position, definitionID: definition } = view;
  const macrostep = view.step.macrostep;
  if (position.at === 'none') {
    return [{ name: 'selecting transitions', hint: 'normal', macrostep }];
  }
  const out = [];
  const action = position.action;
  if (action !== null) {
    const info = labels.actionInfo(definition, action);
    const foreachNext = info?.kind === 'foreach';
    out.push({ name: `${labels.action(definition, action)}${foreachNext ? ` iteration ${position.iteration + 1}` : ''}`,
               hint: 'normal', place: sources.place(definition, 'action', action), macrostep });
    // The iteration is the innermost loop's: the one this action is in,
    // unless the action is a loop itself (core ADR 0083, open point 2).
    let innermost = !foreachNext;
    for (const owner of labels.enclosing(definition, action)) {
      let name = labels.action(definition, owner);
      if (labels.actionInfo(definition, owner)?.kind === 'foreach') {
        if (innermost) name += ` iteration ${position.iteration + 1}`;
        innermost = false;
      }
      out.push({ name, hint: 'normal', place: sources.place(definition, 'action', owner), macrostep });
    }
  }
  const block = position.at === 'transition' ? sources.place(definition, 'transition', position.transition)
    : position.state === null ? undefined : sources.place(definition, 'state', labels.stateID(definition, position.state));
  out.push({ name: blockName(position, definition, labels), hint: 'normal', place: block, macrostep });
  return out;
}

function blockName(position, definition, labels) {
  switch (position.at) {
    case 'exit': return `onexit of ${position.state}`;
    case 'transition': return `transition ${labels.transition(definition, position.transition)}`;
    case 'enter': {
      const outer = position.action === null ? undefined
        : labels.actionInfo(definition, labels.enclosing(definition, position.action).at(-1) ?? position.action);
      return outer?.block === 'onentry' ? `onentry of ${position.state}` : `entering ${position.state}`;
    }
    case 'select': return 'selecting transitions';
    case 'finalize': return `finalize in ${position.state}`;
    case 'invoke': return `starting the invocations of ${position.state}`;
    case 'bootstrap': return 'bootstrap';
    default: return position.at;
  }
}

function stepFrames(view, seen, sources) {
  const { macrostep, microstep } = view.step;
  const out = [];
  if (microstep > 0) {
    const known = seen?.microstep !== undefined && seen.macrostep === macrostep && seen.microstep.number === microstep;
    const taken = known ? `: ${seen.microstep.transitions.join('; ') || 'goto'}` : '';
    const first = known ? seen.microstep.transitionIDs[0] : undefined;
    out.push({ name: `microstep ${macrostep}.${microstep}${taken}`, hint: 'normal', macrostep,
               place: first === undefined ? undefined : sources.place(view.definitionID, 'transition', first) });
  }
  const event = view.currentEvent === null ? '' : ` on ${view.currentEvent.name}`;
  out.push({ name: `macrostep ${macrostep}${event}`, hint: 'normal', macrostep });
  return out;
}

module.exports = { frames, leaves };
