import fs from "node:fs";
import { expect, test } from "bun:test";
import { beefAPIVideoContract } from "../src/lib/beefapi-video-contracts";
import { portraitPriceLines, sanitizeVideoPriceQuote } from "../src/lib/seedance-portrait";
import { SYSTEM_PROMPT } from "../../agent-host/system-prompt.mjs";

test("H3 preserves CNY seconds and 768p without accepting unverified model aliases", () => {
    expect(beefAPIVideoContract("minimax-h3-max-turbo")?.protocol).toBe("newapi-channel-2");
    expect(beefAPIVideoContract("minimax-h3-max")?.protocol).toBe("newapi-channel-2");
    expect(beefAPIVideoContract("minimax-h3")?.maxReferences).toEqual({image: 9, video: 3, audio: 3});
    expect(beefAPIVideoContract("minimax-h3-max-turbo-other")).toBeUndefined();
    const price = {currency: "CNY", mode: "seconds", rates: {"768p": {output: 0.2441304, reference_video: 0}}};
    expect(sanitizeVideoPriceQuote(price)).toEqual(price);
    expect(portraitPriceLines(price)).toEqual(["768p：¥0.2441 / 秒"]);
    expect(sanitizeVideoPriceQuote({...price, currency: "USD"})).toBeNull();
});

test("H3 2K price includes the first-five-reference-image allowance", () => {
    const price = {currency: "CNY", mode: "seconds", rates: {"2k": {output: 1.322373, reference_video: 0}, "4k": {output: 1.627536, reference_video: 0}}, reference_image: 0.813768, free_reference_images: 5};
    expect(sanitizeVideoPriceQuote(price)).toEqual(price);
    expect(portraitPriceLines(price)).toEqual(["2k：¥1.3224 / 秒", "4k：¥1.6275 / 秒", "前 5 张参考图免费，之后 ¥0.8138 / 张"]);
    expect(sanitizeVideoPriceQuote({...price, free_reference_images: -1})).toBeNull();
    expect(sanitizeVideoPriceQuote({...price, reference_image: NaN})).toBeNull();
});

test("assistant H3 guidance matches canvas frame selection", () => {
    expect(SYSTEM_PROMPT).not.toContain("H3 系列");
    const skills = JSON.parse(fs.readFileSync(new URL("../../backend/internal/skills/seed/skills.json", import.meta.url), "utf8")) as Array<{skill_id: string; instruction: string}>;
    const producerSkill = skills.find((item) => item.skill_id === "14811816970252");
    for (const instruction of ["一张图作为首帧", "两张图作为首尾帧", "画幅随图片", "为各镜头生成", "不用于多素材参考模式"]) {
        expect(producerSkill?.instruction).toContain(instruction);
    }
});
