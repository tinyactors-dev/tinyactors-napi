// The game server as a process of its own, which main.mjs starts, kills
// and starts again. It talks over its standard input and output, one JSON
// object a line: inputs in ({ op: 'register' | 'queue' | 'leave' | 'move',
// ... }, 'report', 'exit'), and the spectator feed and the answers out.
//
//   node server.mjs --dir DIR [--datamodel native|quickjs] [--recovery replay|lose]
//                   [--turn-ms MS] [--checkpoint-ms MS]
//
// It opens DIR's checkpoint when there is one (a recovery), else starts a
// new game, and checkpoints every --checkpoint-ms and at each match's end.
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { GameServer } from './game.mjs';
import { Store } from './store.mjs';

const { values } = parseArgs({
  options: {
    dir: { type: 'string' },
    datamodel: { type: 'string', default: 'native' },
    recovery: { type: 'string', default: 'replay' },
    'turn-ms': { type: 'string', default: '250' },
    'checkpoint-ms': { type: 'string', default: '200' },
  },
});

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const started = performance.now();
const server = await GameServer.open({
  store: new Store(values.dir),
  publish: (message) => out({ type: 'feed', message }),
  datamodel: values.datamodel,
  recovery: values.recovery,
  rules: { turnMs: Number(values['turn-ms']), maxTimeouts: 2 },
});
out({ type: 'ready', ms: Math.round(performance.now() - started), stats: server.stats });

const timer = setInterval(() => {
  server.checkpoint().catch((error) => out({ type: 'error', message: `checkpoint: ${error.message}` }));
}, Number(values['checkpoint-ms']));

const lines = createInterface({ input: process.stdin });
lines.on('line', async (line) => {
  const input = JSON.parse(line);
  switch (input.op) {
    case 'register': return server.register(input.name, input.rating);
    case 'queue': return server.queue(input.name, input.ticket);
    case 'leave': return server.leave(input.name);
    case 'move': return server.move(input.match, input.player, input.turn, input.cell);
    case 'report': {
      const players = {};
      for (const name of input.players) {
        const { state, match, ticket, requeue, games, wins, losses, draws, rating } = await server.player(name);
        players[name] = { state, match, ticket, requeue, games, wins, losses, draws, rating };
      }
      const { active, finished, restarts } = await server.lobby();
      return out({ type: 'report', players, lobby: { active, finished, restarts }, stats: server.stats, error: server.checkpointError?.message });
    }
    case 'exit':
      clearInterval(timer);
      server.close();
      lines.close();
      return out({ type: 'closed' });
    default:
      return out({ type: 'error', message: `unknown op ${input.op}` });
  }
});
// the parent went away: nothing will read what this process writes
lines.on('close', () => {
  clearInterval(timer);
  server.close();
});
