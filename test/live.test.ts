/**
 * Against the real Limrun service. Costs a minute or two of simulator time,
 * so it only runs with LIMRUN_LIVE=1 and a key (LIM_API_KEY or lim login):
 *
 *   LIMRUN_LIVE=1 npx vitest run test/live.test.ts
 */
import { afterAll, describe, expect, it } from "vitest";

import { defaultKeyEnvironment, resolveApiKey } from "../src/key";
import { INSTALL_LABEL, THREAD_LABEL, threadSelector } from "../src/labels";
import { createLimrunGateway, type Device, type LimrunGateway } from "../src/limrun";

const live = process.env.LIMRUN_LIVE === "1";
const thread = `thr_livecheck${Date.now().toString(36)}`;

describe.runIf(live)("real Limrun", () => {
  let gateway: LimrunGateway;
  let device: Device | null = null;

  afterAll(async () => {
    if (device !== null) await gateway.remove("ios", device.id);
  });

  it("starts a labeled iPhone, streams it, relabels it and stops it", async () => {
    const key = await resolveApiKey(defaultKeyEnvironment());
    expect(key).not.toBeNull();
    gateway = createLimrunGateway(key!.key);

    const started = Date.now();
    device = await gateway.createIos({
      model: "iphone",
      displayName: "bb: live check",
      labels: { [THREAD_LABEL]: thread, [INSTALL_LABEL]: "bbi-livecheck" },
    });
    console.log(`ready in ${Date.now() - started} ms`, device.id, device.state, device.region);
    expect(device.threadId).toBe(thread);
    expect(device.installId).toBe("bbi-livecheck");
    expect(device.model).toBe("iphone");

    const listed = await gateway.list("ios", { labelSelector: threadSelector(thread), live: true });
    expect(listed.map((each) => each.id)).toContain(device.id);

    const stream = await gateway.stream(device.id);
    expect(stream).not.toBeNull();
    console.log("stream", { url: stream!.url.replace(/\?.*/, "") });

    const reread = await gateway.get("ios", device.id);
    expect(reread?.threadId).toBe(thread);

    await gateway.remove("ios", device.id);
    const gone = await gateway.get("ios", device.id);
    console.log("after delete", gone?.state, gone?.terminationReason);
    expect(["terminating", "terminated"]).toContain(gone?.state);
    device = null;

    const usage = await gateway.usage({
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to: new Date().toISOString(),
    });
    console.log("usage", JSON.stringify(usage));
  }, 300_000);
});
