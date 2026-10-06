import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { MissionEvent } from "../../server/mission-contract.js";
import { actionLabels } from "../../server/mission-contract.js";

async function incident(page: Page, scenario: string, profile = "baseline") {
  await page.goto("/");
  await page.getByText("Incident setup and reproducible variations", { exact: true }).click();
  await page.getByRole("combobox", { name: "Incident", exact: true }).selectOption(scenario);
  await page.getByRole("combobox", { name: "Variation", exact: true }).selectOption(profile);
  await page
    .getByRole("textbox", { name: "Replay seed", exact: true })
    .fill("release-browser-check");
  await page.getByRole("button", { name: "Start configured incident", exact: true }).click();
  await page.getByRole("button", { name: "Get mission team assessment", exact: true }).click();
}
async function authorize(page: Page) {
  await page.getByRole("button", { name: "Review and authorize plan", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Authorize the proposed actions", exact: true })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause simulation", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Authorize plan", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause simulation", exact: true })).toBeVisible();
}
test("specialist roles, symbols, and model details appear throughout the console", async ({
  page,
}) => {
  await incident(page, "dust_storm");
  await expect(
    page.getByRole("button", { name: "Review and authorize plan", exact: true })
  ).toBeVisible();
  const roles = [
    ["Power & Thermal", "power-thermal"],
    ["Life Support", "life-support"],
    ["Weather & Navigation", "weather-navigation"],
    ["Risk Review", "risk-review"],
  ];
  await expect(page.locator(".flow-director > span")).toHaveText("Mission Director");
  await expect(page.locator(".flow-plan > span")).toHaveText("Approval-ready plan");
  await expect(
    page.getByRole("heading", { name: "Agent interaction flow", exact: true })
  ).toBeVisible();
  for (const [name, mark] of roles) {
    for (const selector of [".flow-specialist", ".report", ".council-record li"]) {
      const card = page.locator(selector).filter({ hasText: name });
      await expect(card).toHaveCount(1);
      await expect(card.locator(".mark-" + mark)).toBeVisible();
      expect(
        await card.evaluate((element) => element.scrollWidth <= element.clientWidth),
        selector + " " + name + " fits without horizontal overflow"
      ).toBe(true);
    }
  }
  await page
    .getByRole("button", { name: "View mission team and model profiles", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Command structure", exact: true });
  await expect(dialog.locator(".director-name")).toHaveText("Mission Director");
  for (const [name] of roles) {
    const member = dialog.locator(".team-member").filter({ hasText: name });
    await expect(member).toBeVisible();
    await expect(member.locator("small")).toContainText(/gpt-6-.*reasoning/);
  }
  await page.getByRole("button", { name: "Close mission team", exact: true }).click();
  await page.reload();
  for (const [name, mark] of roles) {
    const card = page.locator(".report").filter({ hasText: name });
    await expect(card.locator(".mark-" + mark)).toBeVisible();
  }
  await expect(page.locator("main")).not.toContainText(/\b(NOVA|AURA|KEPLER|MERCURY)\b/);
});
test("commander approval, pause across refresh, automatic execution and downloadable audit record", async ({
  page,
}) => {
  await incident(page, "dust_storm");
  await expect(
    page.getByRole("button", { name: "Review and authorize plan", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Question or requested revision", exact: true })
  ).toBeHidden();
  await authorize(page);
  await page.getByRole("button", { name: "Pause simulation", exact: true }).click();
  await expect(page.getByText("Simulation paused · time is frozen", { exact: true })).toBeVisible();
  const frozen = await page.getByLabel("Simulated time until impact", { exact: true }).innerText();
  await page.reload();
  await expect(page.getByRole("button", { name: "Resume simulation", exact: true })).toBeVisible();
  await expect(page.getByLabel("Simulated time until impact", { exact: true })).toHaveText(frozen);
  await page.getByRole("button", { name: "Resume simulation", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "The incident is contained", exact: true })
  ).toBeVisible({ timeout: 40000 });
  await expect(
    page.getByText("Simulation stopped · outcome measured", { exact: true })
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download mission record", exact: true }).click();
  expect((await download).suggestedFilename()).toBe("ares-mission-record.json");
});
test("execution failure automatically replans and waits for another commander authorization", async ({
  page,
}) => {
  await incident(page, "rover_recovery", "repair_failure");
  await expect(
    page.getByRole("button", { name: "Review and authorize plan", exact: true })
  ).toBeVisible();
  await authorize(page);
  await expect(
    page.getByRole("listitem").filter({
      hasText: "Revised proposal ready for commander review. No new actions dispatched.",
    })
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByText("Execution stopped · new authorization required", { exact: true })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause simulation", exact: true })).toHaveCount(0);
  await authorize(page);
  await expect(
    page.getByRole("heading", { name: "The incident is contained", exact: true })
  ).toBeVisible({ timeout: 40000 });
});
test("delayed sensor observations are labeled in the console", async ({ page }) => {
  await incident(page, "coolant_leak", "delayed_sensors");
  await expect(page.getByText("Delayed observation", { exact: true }).first()).toBeVisible();
});

async function askDirector(page: Page, request: string) {
  await page.getByText("Ask about or revise this plan", { exact: true }).click();
  const send = page.getByRole("button", { name: "Send to Director", exact: true });
  await expect(send).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Question or requested revision", exact: true })
    .fill("   ");
  await expect(send).toBeDisabled();
  await page
    .getByRole("textbox", { name: "Question or requested revision", exact: true })
    .fill("  " + request + "  ");
  const submitted = page.waitForRequest(
    (request) => request.url().endsWith("/api/mission/convene") && request.method() === "POST"
  );
  await send.click();
  expect((await submitted).postDataJSON()).toEqual({ reviewRequest: request });
}

test("a commander question returns an explanation, preserves actions and time, and still requires approval", async ({
  page,
}) => {
  await incident(page, "rover_recovery");
  const proposal = page.getByRole("region", { name: "Director's proposed plan", exact: true });
  await expect(proposal.getByRole("heading", { name: "Test response", exact: true })).toBeVisible();
  const originalActions = await proposal.locator(".plan-actions span").allTextContents();
  const frozen = await page.getByLabel("Simulated time until impact", { exact: true }).innerText();
  await askDirector(page, "What happens if the backup relay never comes online?");
  await expect(
    proposal.getByRole("heading", { name: "Plan clarification", exact: true })
  ).toBeVisible();
  await expect(proposal).toContainText("If the relay never recovers, repair cannot progress");
  await expect(proposal.locator(".plan-actions span")).toHaveText(originalActions);
  await expect(page.getByLabel("Simulated time until impact", { exact: true })).toHaveText(frozen);
  await expect(page.getByRole("button", { name: "Pause simulation", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(
    proposal.getByRole("heading", { name: "Plan clarification", exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Question or requested revision", exact: true })
  ).toBeHidden();
  await authorize(page);
  await expect(
    page.getByRole("heading", { name: "The incident is contained", exact: true })
  ).toBeVisible({ timeout: 40000 });
});

test("a commander revision changes the plan and executes only the newly confirmed actions", async ({
  page,
}) => {
  await incident(page, "dust_storm");
  const proposal = page.getByRole("region", { name: "Director's proposed plan", exact: true });
  await expect(proposal.getByRole("heading", { name: "Test response", exact: true })).toBeVisible();
  await expect(proposal).not.toContainText(actionLabels.verify_orbital_weather);
  const frozen = await page.getByLabel("Simulated time until impact", { exact: true }).innerText();
  await askDirector(page, "Add an orbital weather cross-check to the plan.");
  await expect(
    proposal.getByRole("heading", { name: "Revised test response", exact: true })
  ).toBeVisible();
  await expect(proposal).toContainText(actionLabels.verify_orbital_weather);
  await expect(page.getByLabel("Simulated time until impact", { exact: true })).toHaveText(frozen);
  await expect(page.getByRole("button", { name: "Pause simulation", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Review and authorize plan", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Authorize the proposed actions", exact: true })
  ).toBeVisible();
  await expect(page.locator(".authorization-details")).toContainText(
    actionLabels.verify_orbital_weather
  );
  await expect(page.getByRole("button", { name: "Pause simulation", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Authorize plan", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "The incident is contained", exact: true })
  ).toBeVisible({ timeout: 40000 });
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download mission record", exact: true }).click();
  const path = await (await download).path();
  const record = JSON.parse(await readFile(path!, "utf8")) as { events: MissionEvent[] };
  const authorized = record.events.filter((event) =>
    event.event.startsWith("Commander authorized:")
  );
  expect(authorized).toHaveLength(1);
  expect(authorized[0].plan?.actions).toEqual([
    "recall_eva",
    "isolate_scrubber",
    "shed_nonessential_load",
    "verify_orbital_weather",
  ]);
  const revisions = record.events.filter(
    (event) => event.event === "Mission Director completed the team decision brief."
  );
  expect(revisions).toHaveLength(2);
  expect(revisions[0].plan?.actions).not.toContain("verify_orbital_weather");
  expect(revisions[1].plan?.actions).toContain("verify_orbital_weather");
  expect(
    record.events.some((event) =>
      event.event.includes("Commander requested a plan review: Add an orbital weather cross-check")
    )
  ).toBe(true);
});
