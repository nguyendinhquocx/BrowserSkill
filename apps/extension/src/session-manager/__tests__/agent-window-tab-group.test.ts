import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWindowTabGroups } from "../agent-window-tab-group";
import { isAgentControlledTab, SessionManager } from "../manager";

function event<T extends unknown[]>() {
  const listeners = new Set<(...args: T) => void>();
  return {
    addListener: (listener: (...args: T) => void) => listeners.add(listener),
    removeListener: (listener: (...args: T) => void) => listeners.delete(listener),
    emit: (...args: T) => {
      for (const listener of listeners) listener(...args);
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const instances: AgentWindowTabGroups[] = [];
afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
  vi.restoreAllMocks();
});

async function fixture() {
  let nextWindow = 10;
  let nextGroup = 100;
  const manager = new SessionManager({
    agentWindow: {
      create: async () => ({ windowId: nextWindow++, initialTabIds: [] }),
      ensureActiveTab: async (id) => id,
      remove: vi.fn(async () => {}),
    },
  });
  const task = await manager.start("one");
  const tabs = new Map<number, chrome.tabs.Tab>();
  const groups = new Map<number, chrome.tabGroups.TabGroup>();
  const addTab = (id: number, extra: Partial<chrome.tabs.Tab> = {}) => {
    const tab = { id, windowId: 10, groupId: -1, pinned: false, ...extra } as chrome.tabs.Tab;
    tabs.set(id, tab);
    return tab;
  };
  addTab(10, { active: true });
  const updated = event<[number, chrome.tabs.TabChangeInfo, chrome.tabs.Tab]>();
  const attached = event<[number, chrome.tabs.TabAttachInfo]>();
  const detached = event<[number, chrome.tabs.TabDetachInfo]>();
  const removed = event<[number, chrome.tabs.TabRemoveInfo]>();
  const groupRemoved = event<[chrome.tabGroups.TabGroup]>();
  const groupMoved = event<[chrome.tabGroups.TabGroup]>();
  const api = {
    tabs: {
      onUpdated: updated,
      onAttached: attached,
      onDetached: detached,
      onRemoved: removed,
      get: vi.fn(async (id: number) => {
        const tab = tabs.get(id);
        if (!tab) throw new Error("Tab closed");
        return { ...tab };
      }),
      query: vi.fn(async (query: chrome.tabs.QueryInfo) =>
        [...tabs.values()]
          .filter(
            (tab) =>
              (query.windowId === undefined || tab.windowId === query.windowId) &&
              (query.groupId === undefined || tab.groupId === query.groupId),
          )
          .map((tab) => ({ ...tab })),
      ),
      group: vi.fn(async (options: chrome.tabs.GroupOptions) => {
        const id = options.groupId ?? nextGroup++;
        if (!groups.has(id))
          groups.set(id, {
            id,
            windowId: options.createProperties!.windowId!,
            color: "grey",
            collapsed: false,
          });
        const group = groups.get(id)!;
        for (const tabId of [options.tabIds!].flat()) {
          const tab = tabs.get(tabId)!;
          // Chrome can move tabs to the group's window: catch stale targets.
          tab.windowId = group.windowId;
          tab.groupId = id;
          updated.emit(tabId, { groupId: id }, { ...tab });
        }
        return id;
      }),
      ungroup: vi.fn(async (ids: number[]) => {
        for (const id of ids) {
          const tab = tabs.get(id)!;
          const group = groups.get(tab.groupId);
          tab.groupId = -1;
          updated.emit(id, { groupId: -1 }, { ...tab });
          if (group && ![...tabs.values()].some((t) => t.groupId === group.id)) {
            groups.delete(group.id);
            groupRemoved.emit(group);
          }
        }
      }),
    },
    tabGroups: {
      onRemoved: groupRemoved,
      onMoved: groupMoved,
      query: vi.fn(async () => [...groups.values()].map((group) => ({ ...group }))),
      get: vi.fn(async (id: number) => {
        const group = groups.get(id);
        if (!group) throw new Error("Group removed");
        return { ...group };
      }),
      update: vi.fn(async (id: number, properties: chrome.tabGroups.UpdateProperties) => {
        const group = groups.get(id)!;
        Object.assign(group, properties);
        return { ...group };
      }),
    },
  };
  const controller = new AgentWindowTabGroups(manager, api as unknown as typeof chrome);
  instances.push(controller);
  const sync = async () => {
    controller.sync();
    // Drain the finite Chrome promise/event chain, including its queued refresh.
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };
  return { manager, task, tabs, groups, addTab, api, controller, sync, attached, detached };
}

describe("Agent Window identification", () => {
  it("creates one orange, expanded BrowserSkill group without changing ownership or selection", async () => {
    const f = await fixture();
    f.addTab(20);
    f.task.agentCreatedTabs.add(20);
    f.addTab(21); // A user tab in the same window remains free.
    f.addTab(22, { windowId: 90 });
    await f.sync();
    await f.sync();
    expect([...f.groups.values()]).toEqual([
      { id: 100, windowId: 10, title: "BrowserSkill", color: "orange", collapsed: false },
    ]);
    expect(f.api.tabs.group).toHaveBeenCalledTimes(1);
    expect(f.api.tabs.group).toHaveBeenCalledWith({
      tabIds: [10, 20],
      createProperties: { windowId: 10 },
    });
    expect(f.tabs.get(21)!.groupId).toBe(-1);
    expect(f.tabs.get(22)!.groupId).toBe(-1);
    expect(isAgentControlledTab(f.task, 21)).toBe(false);
    expect(f.tabs.get(10)!.active).toBe(true);
  });

  it("adds created, borrowed and observed tabs after a claim, preserving a collapsed group", async () => {
    const f = await fixture();
    await f.sync();
    f.groups.get(100)!.collapsed = true;
    f.addTab(20);
    f.addTab(21);
    f.addTab(22);
    f.attached.emit(21, { newWindowId: 10, newPosition: 1 });
    await f.sync();
    expect(f.tabs.get(21)!.groupId).toBe(-1);
    f.task.agentCreatedTabs.add(20);
    f.task.borrowedTabs.set(21, { tabId: 21, originalIndex: 0, originalWindowId: 90 });
    f.task.observedTabs = new Set([22]);
    await f.sync();
    expect([20, 21, 22].map((id) => f.tabs.get(id)!.groupId)).toEqual([100, 100, 100]);
    expect(f.groups.get(100)!.collapsed).toBe(true);
  });

  it("keeps pinned tabs and existing user groups, even if their name is BrowserSkill", async () => {
    const f = await fixture();
    f.addTab(20, { pinned: true });
    f.addTab(21, { groupId: 200 });
    f.task.agentCreatedTabs.add(20).add(21);
    f.groups.set(200, {
      id: 200,
      windowId: 10,
      title: "BrowserSkill",
      color: "blue",
      collapsed: true,
    });
    await f.sync();
    expect(f.tabs.get(20)!.groupId).toBe(-1);
    expect(f.tabs.get(21)!.groupId).toBe(200);
    expect(f.groups.get(200)!.color).toBe("blue");
    await f.manager.stop("one", { dropOnly: true });
    await f.sync();
    expect([...f.groups.keys()]).toEqual([200]);
    expect(f.tabs.get(10)!.groupId).toBe(-1);
    expect(f.tabs.size).toBe(3);
  });

  it("keeps sessions in separate groups", async () => {
    const f = await fixture();
    await f.manager.start("two");
    f.addTab(11, { windowId: 11 });
    await f.sync();
    expect(f.groups.get(100)!.windowId).toBe(10);
    expect(f.groups.get(101)!.windowId).toBe(11);
    await f.manager.stop("one", { dropOnly: true });
    await f.sync();
    expect([...f.groups.keys()]).toEqual([101]);
  });

  it("does not pull a returned tab back into the task window", async () => {
    const f = await fixture();
    await f.sync();
    f.addTab(20);
    f.task.borrowedTabs.set(20, { tabId: 20, originalWindowId: 90, originalIndex: 0 });
    const get = f.api.tabs.get.getMockImplementation()!;
    f.api.tabs.get.mockImplementationOnce(async (id) => {
      f.tabs.get(id)!.windowId = 90;
      f.task.borrowedTabs.delete(id);
      return get(id);
    });
    await f.sync();
    expect(f.tabs.get(20)!.windowId).toBe(90);
    expect(f.api.tabs.group).toHaveBeenCalledTimes(1);
  });

  it("does not create a group if the task ends during a lookup", async () => {
    const f = await fixture();
    const gate = deferred<chrome.tabs.Tab[]>();
    f.api.tabs.query.mockReturnValueOnce(gate.promise);
    f.controller.sync();
    await f.manager.stop("one", { dropOnly: true });
    gate.resolve([{ ...f.tabs.get(10)! }]);
    await f.sync();
    expect(f.api.tabs.group).not.toHaveBeenCalled();
  });

  it("cleans up a group whose creation completes after session stop", async () => {
    const f = await fixture();
    const gate = deferred<void>();
    const group = f.api.tabs.group.getMockImplementation()!;
    f.api.tabs.group.mockImplementationOnce(async (options) => {
      await gate.promise;
      return group(options);
    });
    await f.sync();
    expect(f.api.tabs.group).toHaveBeenCalledTimes(1);
    await f.manager.stop("one", { dropOnly: true });
    f.controller.sync();
    gate.resolve();
    await f.sync();
    expect(f.groups.size).toBe(0);
    expect(f.api.tabGroups.update).not.toHaveBeenCalled();
  });

  it("removes the label from a group moved out of the task window and recreates it for remaining task tabs", async () => {
    const f = await fixture();
    await f.sync();
    f.groups.get(100)!.windowId = 90;
    f.tabs.get(10)!.windowId = 90;
    f.addTab(20);
    f.task.agentCreatedTabs.add(20);
    await f.sync();
    expect(f.tabs.get(10)!.windowId).toBe(90);
    expect(f.tabs.get(10)!.groupId).toBe(-1);
    expect(f.groups.get(101)).toMatchObject({
      title: "BrowserSkill",
      color: "orange",
      windowId: 10,
    });
  });

  it("rechecks a group destination before adding newly claimed tabs", async () => {
    const f = await fixture();
    await f.sync();
    f.addTab(20);
    f.task.agentCreatedTabs.add(20);
    const get = f.api.tabGroups.get.getMockImplementation()!;
    f.api.tabGroups.get.mockImplementationOnce(async (id) => {
      f.groups.get(id)!.windowId = 90;
      f.tabs.get(10)!.windowId = 90;
      return get(id);
    });
    await f.sync();
    expect(f.tabs.get(20)!.windowId).toBe(10);
    expect(f.tabs.get(20)!.groupId).toBe(101);
  });

  it("recovers from group deletion without reusing the old group id", async () => {
    const f = await fixture();
    await f.sync();
    await f.api.tabs.ungroup([10]);
    await f.sync();
    expect(f.tabs.get(10)!.groupId).toBe(101);
    expect([...f.groups.values()]).toHaveLength(1);
  });

  it("isolates cosmetic API failures and retries on a later sync", async () => {
    const f = await fixture();
    vi.spyOn(console, "debug").mockImplementation(() => {});
    f.api.tabs.group.mockRejectedValueOnce(new Error("Tabs cannot be edited right now"));
    await f.sync();
    expect(f.manager.get("one")).toBe(f.task);
    expect(f.task.agentCreatedTabs.has(10)).toBe(true);
    f.api.tabs.onUpdated.emit(10, { status: "complete" }, f.tabs.get(10)!);
    await f.sync();
    expect(f.groups.get(100)!.title).toBe("BrowserSkill");
    f.api.tabGroups.query.mockRejectedValueOnce(new Error("Temporary failure"));
    await f.sync();
    expect(f.groups.size).toBe(1);
    expect(f.api.tabs.group).toHaveBeenCalledTimes(2);
  });

  it("does not recreate groups while Chrome is closing the window", async () => {
    const f = await fixture();
    await f.manager.withExpectedWindowClose(f.task, () => f.sync());
    expect(f.api.tabs.group).not.toHaveBeenCalled();
  });

  it("does not ungroup a page the user moved to another group during cleanup", async () => {
    const f = await fixture();
    await f.sync();
    await f.manager.stop("one", { dropOnly: true });
    const get = f.api.tabs.get.getMockImplementation()!;
    f.api.tabs.get.mockImplementationOnce(async (id) => {
      f.tabs.get(id)!.groupId = 200;
      f.groups.delete(100);
      f.groups.set(200, {
        id: 200,
        windowId: 10,
        title: "User group",
        color: "blue",
        collapsed: false,
      });
      return get(id);
    });
    await f.sync();
    expect(f.api.tabs.ungroup).not.toHaveBeenCalled();
    expect(f.tabs.get(10)!.groupId).toBe(200);
  });

  it("stops pending lookups and listeners when disposed", async () => {
    const f = await fixture();
    const gate = deferred<chrome.tabs.Tab[]>();
    f.api.tabs.query.mockReturnValueOnce(gate.promise);
    f.controller.sync();
    f.controller.dispose();
    gate.resolve([{ ...f.tabs.get(10)! }]);
    await f.sync();
    expect(f.api.tabs.group).not.toHaveBeenCalled();
  });
});
