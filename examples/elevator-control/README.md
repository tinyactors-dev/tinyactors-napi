# Elevator control

A bank of elevators and its dispatcher. Each car is an actor of
[`charts/car.scxml`](charts/car.scxml), each door cycle an actor of
[`charts/door.scxml`](charts/door.scxml) that the car invokes, and one
actor of [`charts/dispatcher.scxml`](charts/dispatcher.scxml) gives the
hall calls to the cars. The application, [`building.mjs`](building.mjs), is
the building around them: the buttons, the load sensors, the maintenance
key switches, the fire alarm, and the hardware the charts drive, which
checks the bank's rules on every report it gets.

The rules, each of them a state, a guard or a timer in the charts:

- **A car's doors never open while it moves, and it never moves with them
  open.** The car's motion, its doors and its load are three regions of
  one parallel state, and the guards between them are `In()`: the doors
  open on `!In('moving')`, the car leaves on `In('closed') &&
  !In('overloaded')`, and a car that stops at a floor waits there until
  its doors report closed.
- **A trip completes.** A trip is the compound state `moving`, one floor
  per `travelMs` on a delayed send, until a floor with a call or the last
  call ahead; its final state `arrived` raises `done.state.moving`, which
  stops the car and opens the doors.
- **The doors cycle on their own timers.** The door controller is invoked
  for each stop: it opens (`doorMs`), dwells (`dwellMs`), closes, and ends,
  which the car gets as `done.invoke.door`. An obstruction or an overload
  while closing opens it again, an overloaded car keeps its doors open past
  the dwell, and a call for the floor the car stands at reopens them.
- **The dispatcher gives each hall call to the cheapest car in service**
  (its distance, plus two floors for each call it holds), and when a car
  leaves service, gives its calls to the others at once. A call that no car
  can take waits for the first car back.
- **Maintenance resumes where the car was.** The key switch takes the car
  out of `operating`, wherever it is: mid-trip (the motor stops, the travel
  timer is cancelled) or with its doors open (the door controller is
  cancelled). The deep history `resume` remembers every active state of all
  three regions, and turning the switch back puts the car exactly there:
  travelling on in the same direction, or cycling its doors again with a
  new controller.
- **The fire alarm brings every car to the lobby with its doors open.**
  The dispatcher passes it to every car, cancels every hall call and
  refuses new ones. A car closes its doors (a controller in mode `close`),
  travels down (the compound state `fireTravel`, whose final state raises
  `done.state.fireTravel`), and opens its doors in the lobby and holds them
  (mode `hold`). The clear closes them and starts normal operation afresh,
  not from the history: the car is in the lobby now.

## What is where

| File | What it holds |
|---|---|
| [`charts/car.scxml`](charts/car.scxml) | a car: the parallel regions and their guards, the trip, maintenance and its deep history, the fire recall |
| [`charts/door.scxml`](charts/door.scxml) | a door controller, invoked by the car: cycle, close or hold, with its timers |
| [`charts/dispatcher.scxml`](charts/dispatcher.scxml) | the dispatcher: assignment, reassignment, waiting calls, the fire alarm |
| [`building.mjs`](building.mjs) | the application: the host, the actors, the inputs, and the `Monitor`, the hardware that checks the rules on every report |
| [`scenarios.mjs`](scenarios.mjs) | a seeded generator of scenarios and the runner that plays them on a `SimulatedClock`, deadline by deadline, checking the invariants |
| [`main.mjs`](main.mjs) | a narrated morning; `--scenarios N` plays N generated scenarios on both datamodels |
| [`test.mjs`](test.mjs) | each rule as a case, on both datamodels; the monitor shown to catch two broken charts; generated scenarios |

## The tinyactors features it uses, and why

- **`<parallel>` and `In()`:** a car is moving, has its doors in some
  state and has some load, all at once, and each region moves on its own
  events. What keeps the car safe is how they constrain each other, which
  `In()` says in the guards where it applies.
- **Done events from compound states:** a trip and a fire recall are each
  a compound state with a final child. The car does not count floors to
  know a trip ended: `done.state.moving` says so, after the floor's
  actions ran.
- **Deep history:** maintenance can interrupt any combination of the
  three regions. Recording which one would take a variable per region and
  a state per combination; `<history type="deep">` records them all, and
  one transition to it restores them.
- **Invoked child charts, `done.invoke` and cancellation:** a door cycle
  has a beginning, timers of its own and an end, so it is an actor of its
  own chart, invoked by the state that needs it (`cycling`, `fireClosing`,
  `fireLobby`, `fireReleasing`) and ended by its final state
  (`done.invoke.<id>`) or cancelled with its timers when the car leaves
  that state, as maintenance and the fire alarm do. The car talks to it
  with `target="#_door"` and it answers to `#_parent`.
- **Delayed sends and `<cancel>`:** travel per floor, the door's movement
  and dwell. Each is armed in an `<onentry>` and cancelled in the
  `<onexit>`, so leaving a state for any reason leaves no timer behind.
- **Named actors and addresses:** the cars and the dispatcher find each
  other by name (`tinyactors://building/@car-1`), with no session ids
  passed around.
- **I/O processors:** `urn:elevator:hw` is the hardware (motor, doors,
  position, modes, overload) and `urn:elevator:report` the dispatcher's
  decisions. The application never drives a car; it only listens.
- **A `SimulatedClock`, stepped deadline by deadline** with
  `host.nextDeadline`, so every timer fires at its own time and a scenario
  of four minutes plays in milliseconds.
- **The typed methods:** `actorState` and `actorContext` for a
  car's active states and variables (the maintenance check),
  `actorGet` for how many door controllers a car runs.
- **Both datamodels:** every case and every scenario runs on the native
  datamodel and on quickjs, and a scenario must come out the same on both.

## SCXML's semantics, as the scenarios found them

Three rules of SCXML shaped the charts. The generated scenarios found
the first two as mistakes in the first version; the third was found
while writing the reopen, and checked by removing the guard (the call
then stays in `hallCalls`):

- **Re-entering a state through history runs its `<onentry>` again.**
  The trip's direction was chosen in `moving`'s `<onentry>`. After
  maintenance, which clears the car's hall calls (the dispatcher gave them
  away), the history re-entered `moving`, and the car turned round
  mid-shaft. The direction is now chosen on the transition that departs
  (`test.mjs` keeps the broken chart as a case the scenarios catch).
- **An invocation starts at the end of the macrostep that entered its
  state.** A history that re-enters `overloaded` and `cycling` at once
  raised `load.over`, whose `hold` went to a door controller that did not
  exist yet. The car now signals its controller only after it said
  `door.started`, and passes `held` as a parameter, read when it starts.
- **Targetless transitions in two regions both run.** A call for the
  floor where the car stands with its doors open is the `stopped` state's
  (a reopen), but `operating` also had a transition on `assign`, which the
  doors region reached through its ancestors: both ran, and the call
  became a second stop. `operating`'s transition is now guarded against
  that case.

## The invariants the scenarios check

`scenarios.mjs` generates a building (2 to 4 cars, 4 to 12 floors, travel,
door and dwell times) and one to four minutes of inputs: hall calls,
presses, loads (some over capacity, then lighter again), obstructions, up
to three maintenance periods, and sometimes a fire alarm, mostly long
enough for the whole recall, sometimes cleared while the cars are still
on their way down. The runner plays them on a `SimulatedClock`, moving it
to the next input or deadline, and adapts what would not happen in a real
building: it never takes the last car in service out, and the load sensor
reads again when a car is back in service. The `Monitor` checks, on every
report and after every step:

- no door opens while its car moves, no car moves (or changes floor) with
  a door that is not closed, a door opens only at the car's floor, and a
  car moves one floor at a time;
- every hall call is with a car in service, or waits only while none is;
  none waits longer than a bound for the car that has it (two sweeps of
  the shaft, a door cycle at each floor of both, and the time the
  scenario holds doors open); and every call is served by the end;
- after a fire alarm, by the time the slowest car needs (`2 * doorMs +
  (floors - 1) * travelMs`), every car is in the lobby, standing, in fire
  mode, with its doors open;
- a car back from maintenance has the active states, floor, direction and
  car calls it had when it went out;
- no chart logged an error, and every car ends at rest with its doors
  closed.

## Run it

From `tinyactors-napi`, after `mise run build`:

```sh
node examples/elevator-control/main.mjs                     # the narrated morning
node examples/elevator-control/main.mjs --scenarios 1000    # on both datamodels
node examples/elevator-control/main.mjs --scenarios 200 --seed 5000 --datamodel quickjs
```

The morning prints every report with its time: two calls, a car taken out
for maintenance on its way up whose call goes to another car and which
resumes its trip when it is back, an overloaded car holding its doors, and
a fire drill. `--scenarios` prints, per datamodel, the scenarios, inputs,
reports and clock steps, how long they took, and any rule broken, and
exits 1 if one was.

## Test it

```sh
mise run examples elevator-control         # under node and bun
node examples/elevator-control/test.mjs
ELEVATOR_FULL=1 node examples/elevator-control/test.mjs        # 1000 scenarios per datamodel
ELEVATOR_SCENARIOS=200 bun test ./examples/elevator-control/test.mjs
```

The default test plays 25 generated scenarios on each datamodel, with
every case, in about two seconds. `ELEVATOR_FULL=1` plays 1000 on each.

## Surprises

Every example's surprises, and what became of each, are in
[docs/surprises.md](../../docs/surprises.md), generated from the log.

Recorded in [`docs/log.xml`](../../docs/log.xml):

- `l-p4-examples-elevator-error-sendid`: an error raised by a `<send>`
  that fails at once (a `#_<invokeid>` with no invocation running, a type
  the config does not list) has no `_event.sendid`, so a chart cannot tell
  which send failed. The car signals its door controller only once it runs.
- `l-p4-examples-elevator-invoke-start`: the charts guide does not say that
  a child is started at the end of the macrostep that entered its state, so
  that a send to it from that macrostep (an `<onentry>`, a raised event, a
  history's re-entry) fails.
