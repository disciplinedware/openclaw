import { describe, expect, it } from "vitest";
import { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";

type ResolveParams = Parameters<typeof resolveWhatsAppOutboundTarget>[0];

const PRIMARY_TARGET = "+11234567890";
const SECONDARY_TARGET = "+19876543210";

describe("resolveWhatsAppOutboundTarget", () => {
  it.each([null, "   ", "invalid"])("rejects missing or invalid target %j", (to) => {
    expect(resolveWhatsAppOutboundTarget({ to, allowFrom: undefined, mode: undefined })).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: "Delivering to WhatsApp requires target <E.164|group JID|newsletter JID|owner>",
      }),
    });
  });

  it.each([
    ["120363123456789@g.us", "implicit"],
    ["120363123456789@newsletter", "implicit"],
  ])("does not apply DM allowFrom to %s in %s mode", (to, mode) => {
    expect(resolveWhatsAppOutboundTarget({ to, allowFrom: [SECONDARY_TARGET], mode })).toEqual({
      ok: true,
      to,
    });
  });

  it.each<[string, ResolveParams["allowFrom"], ResolveParams["mode"]]>([
    ["wildcard", ["*"], "implicit"],
    ["empty allowFrom", [], "implicit"],
    ["numeric target beside invalid entry", [11234567890, "invalid"], "implicit"],
    ["whitespace in allowFrom", [`  ${PRIMARY_TARGET}  `], undefined],
    ["no policy in null mode", undefined, null],
  ])("allows %s", (_label, allowFrom, mode) => {
    expect(resolveWhatsAppOutboundTarget({ to: PRIMARY_TARGET, allowFrom, mode })).toEqual({
      ok: true,
      to: PRIMARY_TARGET,
    });
  });

  it("denies an unlisted target with its normalized address", () => {
    expect(
      resolveWhatsAppOutboundTarget({
        to: "  +1 (123) 456-7890  ",
        allowFrom: [SECONDARY_TARGET],
        mode: "heartbeat",
      }),
    ).toEqual({
      ok: false,
      error: expect.objectContaining({
        message: `Target "${PRIMARY_TARGET}" is not listed in the configured WhatsApp allowFrom policy.`,
      }),
    });
  });

  it("trims the resolved target", () => {
    expect(
      resolveWhatsAppOutboundTarget({
        to: `  ${PRIMARY_TARGET}  `,
        allowFrom: undefined,
        mode: undefined,
      }),
    ).toEqual({ ok: true, to: PRIMARY_TARGET });
  });
});

describe("resolveWhatsAppOutboundTarget owner", () => {
  const OWNER = "+15550000200";
  const cfg = (ownerAllowFrom: string[]) => ({ commands: { ownerAllowFrom } }) as never;

  it.each(["owner", "whatsapp:owner", " Owner "])(
    "sends %j to the one WhatsApp owner, whatever allowFrom admits",
    (to) => {
      expect(
        resolveWhatsAppOutboundTarget({
          cfg: cfg([`whatsapp:${OWNER}`, "telegram:123456789"]),
          to,
          allowFrom: [PRIMARY_TARGET],
          mode: "implicit",
        }),
      ).toEqual({ ok: true, to: OWNER });
    },
  );

  it.each([
    ["no owner", []],
    ["two owners", [`whatsapp:${OWNER}`, `whatsapp:${SECONDARY_TARGET}`]],
  ])("refuses owner with %s, naming no number", (_label, owners) => {
    const resolution = resolveWhatsAppOutboundTarget({
      cfg: cfg(owners),
      to: "owner",
      allowFrom: ["*"],
      mode: "implicit",
    });
    expect(resolution.ok).toBe(false);
    expect(resolution.ok ? "" : resolution.error.message).not.toMatch(/\+\d/);
  });
});

describe("resolveWhatsAppOutboundTarget Mexican mobiles", () => {
  it("admits a +521 target when allowFrom lists the person as +52", () => {
    expect(
      resolveWhatsAppOutboundTarget({
        to: "+5219980000102",
        allowFrom: ["+529980000102"],
        mode: "implicit",
      }),
    ).toEqual({ ok: true, to: "+529980000102" });
  });
});
