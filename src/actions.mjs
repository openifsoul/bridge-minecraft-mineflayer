import pathfinder from "mineflayer-pathfinder";
import pvp from "mineflayer-pvp";

const { GoalBlock, GoalFollow } = pathfinder.goals;
const directions = [
  ["north", 0, -1],
  ["south", 0, 1],
  ["east", 1, 0],
  ["west", -1, 0],
];
const hostile = new Set([
  "zombie",
  "husk",
  "skeleton",
  "stray",
  "spider",
  "cave_spider",
]);
const MAX_DISTANCE = 24;
const TIMEOUT = 12000;

export function loadActionPlugins(bot) {
  bot.loadPlugin(pathfinder.pathfinder);
  bot.loadPlugin(pvp.plugin);
}

export function createActions(bot, config, report) {
  let active;
  const movement = () => config.actions?.includes("movement") && bot.pathfinder;
  const defense = () =>
    movement() && config.actions.includes("defense") && bot.pvp;
  const player = () => {
    const found = bot.players?.[config.playerName];
    return found?.uuid === config.playerUuid ? found.entity : undefined;
  };
  const nearby = (entity, range) =>
    entity?.isValid && bot.entity.position.distanceTo(entity.position) <= range;
  function finish(result) {
    const job = active;
    if (!job) return;
    active = undefined;
    clearTimeout(job.timer);
    if (job.id === "defend") bot.pvp.forceStop();
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    report(job.id, result);
  }
  function snapshot() {
    if (!movement() || !bot.entity?.position || !nearby(player(), MAX_DISTANCE))
      return [];
    const origin = bot.entity.position.floored();
    const choices = [];
    const target = player();
    choices.push({
      id: "follow",
      label: "Follow the approved player",
      entity: target,
    });
    const destination = target.position.floored();
    choices.push({
      id: "come",
      label: `Walk to the player's current block (${destination.x}, ${destination.y}, ${destination.z})`,
      point: destination,
    });
    for (const [name, x, z] of directions) {
      const point = origin.offset(x * 5, 0, z * 5);
      choices.push({
        id: name,
        label: `Walk five blocks ${name} to (${point.x}, ${point.y}, ${point.z})`,
        point,
      });
    }
    const entity =
      defense() &&
      bot.nearestEntity(
        (candidate) =>
          candidate.type !== "player" &&
          hostile.has(candidate.name) &&
          nearby(candidate, 6),
      );
    if (entity)
      choices.push({
        id: "defend",
        label: `Defend against the nearby ${entity.name}`,
        entity,
      });
    return choices;
  }
  function safe(job) {
    if (job.player !== player() || !nearby(job.player, MAX_DISTANCE))
      return false;
    if (bot.entity.position.distanceTo(job.origin) > MAX_DISTANCE) return false;
    if (
      job.entity &&
      (!nearby(job.entity, job.id === "defend" ? 8 : MAX_DISTANCE) ||
        bot.entities[job.entity.id] !== job.entity)
    )
      return false;
    return (
      !job.point || bot.entity.position.distanceTo(job.point) <= MAX_DISTANCE
    );
  }
  function execute(choice, boundPlayer) {
    if (!movement() || !choice || active || !bot.entity?.position) return false;
    const job = {
      ...choice,
      player: boundPlayer,
      origin: bot.entity.position.clone(),
    };
    if (!safe(job)) return false;
    const movements = new pathfinder.Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowParkour = false;
    movements.scafoldingBlocks = [];
    bot.pathfinder.setMovements(movements);
    active = job;
    job.timer = setTimeout(() => finish("expired"), TIMEOUT);
    try {
      if (job.id === "defend") {
        bot.pvp.movements = movements;
        bot.pvp.viewDistance = 8;
        void bot.pvp.attack(job.entity).then(
          () => {
            if (active !== job && bot.pvp.target === job.entity)
              bot.pvp.forceStop();
          },
          () => {
            if (active === job) finish("failed");
          },
        );
      } else if (job.id === "follow") {
        bot.pathfinder.setGoal(new GoalFollow(job.entity, 2), true);
      } else {
        bot.pathfinder.setGoal(
          new GoalBlock(job.point.x, job.point.y, job.point.z),
        );
      }
      return true;
    } catch {
      finish("failed");
      return false;
    }
  }
  return {
    get acting() {
      return Boolean(active);
    },
    snapshot,
    execute,
    player,
    stop: () => finish("stopped"),
    tick() {
      if (active && !safe(active)) finish("interrupted");
    },
    reached(goal) {
      const job = active;
      if (
        job?.point &&
        bot.pathfinder.goal === goal &&
        bot.entity.position.floored().equals(job.point)
      )
        finish("arrived");
    },
    dead(entity) {
      if (active?.id === "defend" && active.entity === entity)
        finish("target-died");
    },
    path(result) {
      const job = active;
      if (job && ["noPath", "timeout"].includes(result.status))
        queueMicrotask(() => {
          if (active === job) finish("unreachable");
        });
    },
  };
}
