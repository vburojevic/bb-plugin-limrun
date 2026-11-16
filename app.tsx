/**
 * Limrun for bb: frontend entry.
 *
 * Four surfaces, each tied to one question:
 * - a Limrun toggle in the composer: should this thread build on Limrun?
 * - "Limrun" in a thread's side panel: what is this thread's cloud simulator
 *   doing? Streamed with touch and keyboard, with start and stop.
 * - a card above the thread's composer, only while a remote build or test
 *   runs and until its verdict is dismissed: did the build pass?
 * - the Limrun page in the sidebar: is Limrun connected, what has it cost,
 *   and what is running right now?
 */
import { definePluginApp } from "@get-bb/plugin-sdk/app";

import "./app.css";

import { DevicePanel } from "./app/DevicePanel";
import { ModeToggle } from "./app/ModeToggle";
import { OrgPage } from "./app/OrgPage";
import { RunsBanner } from "./app/RunsBanner";

export default definePluginApp((app) => {
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "device",
    title: "Limrun",
    tooltip: "Limrun cloud simulator",
    icon: "Cloud",
    layout: "flush",
    component: DevicePanel,
  });

  app.composer.customize({
    id: "limrun-mode",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "build-on-limrun", component: ModeToggle }],
  });

  app.composer.customize({
    id: "limrun-runs",
    scopes: ["thread"],
    banners: [{ id: "runs", chrome: "bare", component: RunsBanner }],
  });

  app.slots.navPanel({
    id: "limrun",
    title: "Limrun",
    icon: "Cloud",
    path: "limrun",
    component: OrgPage,
  });
});
