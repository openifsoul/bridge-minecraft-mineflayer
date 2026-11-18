import pathfinder from "mineflayer-pathfinder";

const { GoalBlock, GoalNear, GoalFollow, GoalLookAtBlock } = pathfinder.goals;
const AXES = ["x", "y", "z"];
const TOOL = /^(wooden|stone|iron|golden|diamond|netherite)_axe$/u;
const LOG = /^(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_log$/u;
const MAX_COUNT = 32;

class ActionFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function contains(region, position) {
  return AXES.every(
    (axis) =>
      position[axis] >= region.min[axis] &&
      position[axis] < region.max[axis] + 1,
  );
}

function at(bot, coordinates) {
  const point = bot.entity.position.floored();
  return point.offset(
    coordinates.x - point.x,
    coordinates.y - point.y,
    coordinates.z - point.z,
  );
}

function distance(bot, point) {
  return bot.entity.position.distanceTo(point);
}

function itemCount(items, type) {
  return items.reduce(
    (total, item) => total + (item?.type === type ? item.count : 0),
    0,
  );
}

function pause(signal, milliseconds) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", interrupt);
      resolve();
    }, milliseconds);
    function interrupt() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", interrupt, { once: true });
  });
}

async function until(test, signal, code, timeout = 4000) {
  const end = Date.now() + timeout;
  do {
    signal.throwIfAborted();
    const result = test();
    if (result) return result;
    await pause(signal, 100);
  } while (Date.now() < end);
  throw new ActionFailure(code);
}

export function createForestReservations() {
  const claimed = new Set();
  const available = (point) => [...claimed].every((other) => other.distanceTo(point) > 4);
  return {
    available,
    claim(point) {
      if (!available(point)) return;
      claimed.add(point);
      return () => claimed.delete(point);
    },
  };
}

export function validateResourcePolicy(policy, { forest = false } = {}) {
  const { dimension, region, resources, containers, harvestRegion } = policy ?? {};
  if (
    typeof dimension !== "string" ||
    !region ||
    !AXES.every(
      (axis) =>
        Number.isInteger(region.min?.[axis]) &&
        Number.isInteger(region.max?.[axis]) &&
        region.max[axis] >= region.min[axis] &&
        region.max[axis] - region.min[axis] <= 48,
    ) ||
    !Array.isArray(resources) ||
    !resources.length ||
    new Set(resources).size !== resources.length ||
    !resources.every((item) => typeof item === "string" && LOG.test(item)) ||
    (forest && (!harvestRegion || !AXES.every((axis) =>
      Number.isInteger(harvestRegion.min?.[axis]) &&
      Number.isInteger(harvestRegion.max?.[axis]) &&
      harvestRegion.min[axis] <= harvestRegion.max[axis]) ||
      !contains(region, harvestRegion.min) || !contains(region, harvestRegion.max))) ||
    (!forest && (!Array.isArray(containers) ||
    !containers.length ||
    containers.length > 8 ||
    new Set(containers.map((entry) => entry?.id)).size !== containers.length ||
    !containers.every(
      (entry) =>
        entry &&
        typeof entry.id === "string" &&
        /^[a-z][a-z0-9-]{0,31}$/u.test(entry.id) &&
        AXES.every((axis) => Number.isInteger(entry.position?.[axis])) &&
        contains(region, entry.position),
    )))
  ) {
    throw new TypeError("Invalid resource action policy");
  }
  return structuredClone(policy);
}

export function resourceMovements(bot, region) {
  const movements = new pathfinder.Movements(bot);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.allowParkour = false;
  movements.scafoldingBlocks = [];
  movements.exclusionAreasStep.push((block) => contains(region, block.position) ? 0 : 100);
  return movements;
}

export async function returnFromForest(bot, policy, home, { signal, authorize, isCurrent, observe }) {
  const valid = () => isCurrent() && bot.game?.dimension === policy.dimension &&
    bot.entity?.position && contains(policy.region, bot.entity.position) && contains(policy.region, home);
  const stop = () => bot.pathfinder.setGoal(null);
  const timeout = AbortSignal.timeout(30000);
  const active = AbortSignal.any([timeout, signal]);
  active.addEventListener("abort", stop, { once: true });
  const monitor = () => { if (!valid()) stop(); };
  bot.on("physicsTick", monitor);
  try {
    if (!valid() || active.aborted || !(await authorize()) || active.aborted || !valid()) {
      return { status: "cancelled", reason: "authorization-lost" };
    }
    bot.pathfinder.setMovements(resourceMovements(bot, policy.region));
    const point = at(bot, home);
    await bot.pathfinder.goto(new GoalBlock(point.x, point.y, point.z));
    if (active.aborted || !valid()) return { status: "cancelled", reason: "return-interrupted" };
    if (bot.entity.position.distanceTo(at(bot, home).offset(0.5, 0, 0.5)) > 1) return { status: "failed", reason: "return-unverified" };
    observe({ stepId: "return", count: 1 });
    return { status: "succeeded" };
  } catch (error) {
    const reason = signal.aborted ? "stopped" : timeout.aborted ? "return-timeout" : pathFailure(error);
    return { status: signal.aborted ? "cancelled" : "failed", reason };
  } finally {
    bot.off("physicsTick", monitor);
    active.removeEventListener("abort", stop);
    stop();
    bot.clearControlStates();
  }
}

function pathFailure(error) {
  return ({
    NoPath: "no-path", Timeout: "path-timeout", GoalChanged: "goal-replaced",
    PathStopped: "path-stopped", Error: "native-action-failed",
  })[error?.name] ?? "native-action-failed";
}

export async function gatherAndDeposit(bot, policy, input, controls) {
  return runResources(bot, policy, input, controls);
}

export async function gatherLogs(bot, policy, input, controls) {
  return runResources(bot, policy, input, controls, true);
}

async function runResources(bot, policy, input, controls, forest = false) {
  const { resource, count, container } = input;
  const { signal, authorize, observe = () => {} } = controls;
  const chest = forest ? undefined : policy.containers.find((entry) => entry.id === container);
  const harvestRegion = forest ? policy.harvestRegion : policy.region;
  const reservations = forest ? controls.reservations : undefined;
  if (
    !policy.resources.includes(resource) ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_COUNT ||
    (forest ? !reservations || !harvestRegion : !chest)
  ) {
    return { status: "failed", reason: "invalid-arguments", gathered: 0, deposited: 0 };
  }

  let gathered = 0;
  let deposited = 0;
  let window;
  let opening;
  const validPosition = () =>
    controls.isCurrent?.() !== false &&
    bot.game?.dimension === policy.dimension &&
    bot.entity?.position &&
    contains(policy.region, bot.entity.position);
  const assertPosition = () => {
    if (!validPosition()) throw new ActionFailure("outside-authorized-region");
  };
  const stop = () => {
    bot.stopDigging();
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    if (window && bot.currentWindow === window) window.close();
  };
  const local = new AbortController();
  const abort = () => local.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const cancellation = local.signal;
  const deadline = setTimeout(
    () => local.abort(new ActionFailure("deadline")),
    120000,
  );
  deadline.unref();
  cancellation.addEventListener("abort", stop, { once: true });
  const onTick = () => {
    if (!validPosition()) local.abort(new ActionFailure("outside-authorized-region"));
  };
  bot.on("physicsTick", onTick);

  async function check() {
    cancellation.throwIfAborted();
    assertPosition();
    if (!(await authorize())) throw new ActionFailure("authorization-lost");
    cancellation.throwIfAborted();
    assertPosition();
  }

  async function walk(point, radius = 1) {
    await check();
    await bot.pathfinder.goto(new GoalNear(point.x, point.y, point.z, radius));
    cancellation.throwIfAborted();
  }

  function chestAt(point) {
    const block = bot.blockAt(point);
    return block?.name === "chest" && block.getProperties().type === "single"
      ? block
      : undefined;
  }

  async function openChest(point) {
    await check();
    const selected = chestAt(point);
    if (!selected || distance(bot, point) > 4 || bot.currentWindow) {
      throw new ActionFailure("container-unavailable");
    }
    opening = bot.openContainer(selected).then((opened) => {
      if (cancellation.aborted) {
        opened.close();
        return;
      }
      window = opened;
    });
    opening.catch(() => {});
    await until(() => window, cancellation, "container-open-unverified");
    opening = undefined;
  }

  function closeChest() {
    window.close();
    window = undefined;
  }

  let phase = "setup";
  let nativeTarget;
  try {
    await check();
    const blockId = bot.registry.blocksByName[resource]?.id;
    const itemId = bot.registry.itemsByName[resource]?.id;
    const chestPoint = chest && at(bot, chest.position);
    if (blockId === undefined || itemId === undefined) throw new ActionFailure("unknown-resource");
    if (chestPoint && !chestAt(chestPoint)) throw new ActionFailure("container-unavailable");
    bot.pathfinder.setMovements(resourceMovements(bot, policy.region));

    const inventory = () => itemCount(bot.inventory.items(), itemId);
    const initialInventory = inventory();
    const unreachable = new Set();
    const start = forest && bot.entity.position.clone();
    let travelRecorded = false;
    phase = "search";
    while (gathered < count) {
      await check();
      const axe = bot.inventory.items().find((item) => TOOL.test(item.name));
      if (!axe) throw new ActionFailure("missing-tool");
      const findTarget = (available) => bot.findBlocks({
        matching: blockId,
        useExtraInfo: (block) => block && contains(harvestRegion, block.position) &&
          !unreachable.has(block.position.toString()) && available(block.position),
        maxDistance: 48,
        count: 1,
      })[0];
      const allowed = reservations?.available ?? (() => true);
      let target = findTarget(allowed);
      if (!target && reservations && findTarget(() => true)) {
        try {
          target = await until(() => findTarget(allowed), cancellation, "resources-reserved", 12000);
        } catch (error) {
          if (error.code === "resources-reserved") break;
          throw error;
        }
      }
      if (!target) break;
      nativeTarget = target;
      const release = reservations?.claim(target);
      if (reservations && !release) continue;
      try {
        const initial = bot.blockAt(target);
        if (!forest || !initial || !bot.canDigBlock(initial) || !bot.canSeeBlock(initial)) {
          try {
            phase = "approach";
            if (forest) {
              await check();
              await bot.pathfinder.goto(new GoalLookAtBlock(target, bot.world, { reach: 4 }));
            } else {
              await walk(target);
            }
            if (forest && !travelRecorded && distance(bot, start) >= 2) {
              travelRecorded = true;
              observe({ stepId: "travel", count: Math.floor(distance(bot, start)) });
            }
          } catch (error) {
            controls.diagnostic?.({ phase, code: pathFailure(error), target: target.toString() });
            if (!forest || !["NoPath", "Timeout", "PathStopped"].includes(error.name)) throw error;
            unreachable.add(target.toString());
            continue;
          }
        }
        const block = bot.blockAt(target);
        if (
          block?.type !== blockId ||
          !contains(harvestRegion, block.position) ||
          !bot.canDigBlock(block)
        ) {
          if (forest) {
            unreachable.add(target.toString());
            continue;
          }
          throw new ActionFailure("resource-unreachable");
        }
        phase = "equip";
        await check();
        await bot.equip(axe, "hand");
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
        await check();
        const latest = bot.blockAt(target);
        if (forest && latest?.stateId === block.stateId && !bot.canSeeBlock(latest)) {
          unreachable.add(target.toString());
          continue;
        }
        if (latest?.stateId !== block.stateId || !bot.canSeeBlock(latest) || !TOOL.test(bot.heldItem?.name ?? "")) {
          throw new ActionFailure("resource-or-tool-changed");
        }
        const before = inventory();
        let pickedUp = false;
        const existing = new Set(Object.keys(bot.entities));
        const isDrop = (entity) =>
          !existing.has(String(entity.id)) &&
          entity.getDroppedItem?.()?.type === itemId &&
          contains(policy.region, entity.position) &&
          entity.position.distanceTo(target) <= 2;
        const onCollect = (actor, entity) => {
          if (actor?.id === bot.entity?.id && isDrop(entity)) pickedUp = true;
        };
        bot.on("playerCollect", onCollect);
        try {
          phase = "dig";
          await bot.dig(latest, "ignore");
          cancellation.throwIfAborted();
          if (bot.blockAt(target)?.type === blockId) throw new ActionFailure("resource-not-broken");
          phase = "drop";
          const drop = await until(
            () => pickedUp || Object.values(bot.entities).find(isDrop),
            cancellation,
            "drop-unavailable",
          );
          if (drop !== true && forest) {
            phase = "pickup";
            await check();
            bot.pathfinder.setGoal(new GoalFollow(drop, 0.65), true);
          } else if (drop !== true) {
            phase = "pickup";
            await walk(drop.position);
            await check();
            if (!pickedUp && isDrop(drop) && drop.isValid) {
              const point = drop.position.floored();
              await bot.pathfinder.goto(new GoalBlock(point.x, point.y, point.z));
            }
          }
          await until(
            () => pickedUp && inventory() >= before + 1,
            cancellation,
            "pickup-unverified",
            forest ? 6000 : 4000,
          );
          gathered++;
          observe({ stepId: "collect", count: gathered });
        } catch (error) {
          controls.diagnostic?.({ phase, code: error.code ?? pathFailure(error), target: target.toString() });
          if (!forest || cancellation.aborted ||
            !["drop-unavailable", "pickup-unverified", "resource-not-broken"].includes(error.code)) throw error;
          unreachable.add(target.toString());
        } finally {
          if (forest) bot.pathfinder.setGoal(null);
          bot.off("playerCollect", onCollect);
        }
      } finally {
        release?.();
      }
    }

    if (!gathered) throw new ActionFailure(unreachable.size ? "no-reachable-resources" : "no-resources");
    if (forest) return {
      status: gathered === count ? "succeeded" : "partial",
      ...(gathered === count ? {} : { reason: "insufficient-resources" }),
      gathered,
      deposited,
    };
    await walk(chestPoint);
    await openChest(chestPoint);
    const containerCount = () => itemCount(window.containerItems(), itemId);
    const windowInventory = () => itemCount(window.slots.slice(window.inventoryStart, window.inventoryEnd), itemId);
    const amount = Math.min(gathered, Math.max(0, windowInventory() - initialInventory));
    if (!amount) throw new ActionFailure("inventory-changed");
    while (deposited < amount) {
      await check();
      if (bot.currentWindow !== window || !chestAt(chestPoint)) {
        throw new ActionFailure("container-changed");
      }
      const beforeChest = containerCount();
      const beforeInventory = windowInventory();
      const hasSpace = window.slots.slice(0, window.inventoryStart).some(
        (item) => !item || (item.type === itemId && item.count < item.stackSize),
      );
      if (!hasSpace) throw new ActionFailure("container-full");
      const source = window.findItemRange(window.inventoryStart, window.inventoryEnd, itemId);
      const destination = window.findItemRange(0, window.inventoryStart, itemId, null, true)?.slot ??
        window.firstEmptySlotRange(0, window.inventoryStart);
      if (!source || destination == null || window.selectedItem) {
        throw new ActionFailure("container-changed");
      }
      // Authorize each native click. The ordinary deposit helper performs a
      // sequence of clicks on its own and can advance after cancellation.
      await bot.clickWindow(source.slot, 0, 0);
      await check();
      if (bot.currentWindow !== window || window.selectedItem?.type !== itemId) {
        throw new ActionFailure("container-changed");
      }
      await bot.clickWindow(destination, 1, 0);
      await check();
      if (bot.currentWindow !== window) throw new ActionFailure("container-changed");
      if (window.selectedItem) await bot.clickWindow(source.slot, 0, 0);
      cancellation.throwIfAborted();
      closeChest();
      await openChest(chestPoint);
      if (containerCount() !== beforeChest + 1 || windowInventory() !== beforeInventory - 1) {
        throw new ActionFailure("deposit-unverified");
      }
      deposited++;
      observe({ stepId: "deposit", count: deposited });
    }
    return {
      status: deposited === count ? "succeeded" : "partial",
      ...(deposited === count ? {} : { reason: "insufficient-resources" }),
      gathered,
      deposited,
    };
  } catch (error) {
    const code = cancellation.reason?.code ?? error.code;
    const reason = typeof code === "string" && /^[a-z][a-z-]{0,40}$/u.test(code)
      ? code : signal.aborted ? "stopped" : pathFailure(error);
    controls.diagnostic?.({ phase, code: reason, target: nativeTarget?.toString() });
    return {
      status: signal.aborted || reason === "authorization-lost"
        ? "cancelled"
        : gathered || deposited ? "partial" : "failed",
      reason,
      gathered,
      deposited,
    };
  } finally {
    clearTimeout(deadline);
    if (opening && !window) {
      // The client cannot cancel its pending native windowOpen listener.
      local.abort(new ActionFailure("container-open-unverified"));
      bot.quit("Resource container did not open");
    } else if (!cancellation.aborted) {
      stop();
    }
    bot.off("physicsTick", onTick);
    signal.removeEventListener("abort", abort);
    cancellation.removeEventListener("abort", stop);
  }
}
