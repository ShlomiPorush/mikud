// Notes against the real server, on the desktop and on a phone (requirements section 10): a new note is written
// and saved through the save bar and gets an address of its own; its Markdown renders with headings one level
// down; an edit adds a version; restoring the first version makes it the newest and Undo brings the edit back;
// the list finds the note by its text and among the general notes; Delete asks first and removes the note. It
// reuses the browser that signed in in auth.spec.ts. The data is invented.
import { type Browser, expect, type Page, test } from "@playwright/test"
import he from "../src/shared/locales/he.json" with { type: "json" }
import { fill, storageFile } from "./helpers.ts"

test.describe.configure({ mode: "serial" })

let page: Page
let run = ""
let noteUrl = ""

const saveBar = () => page.locator(".ui-savebar")
const versions = () => page.locator("#note-versions .ui-item")

test.beforeAll(async ({ browser }: { browser: Browser }, testInfo) => {
  run = `${testInfo.project.name}-${Date.now().toString(36)}`
  page = await (
    await browser.newContext({ ...testInfo.project.use, storageState: storageFile(testInfo.project.name) })
  ).newPage()
})

test("writes a new note and saves it to an address of its own", async () => {
  await page.goto("/notes")
  await page.waitForLoadState("networkidle")
  await page.getByRole("link", { name: he.notes.new }).first().click()
  await expect(page).toHaveURL(/\/notes\/new$/)
  await page.locator("#note-title-field").fill(`Greenhouse vents ${run}`)
  await page.locator("#note-body").fill("# Vents\n\nOpen the **north** vents above 24 degrees.")
  await expect(saveBar()).toBeVisible()
  await saveBar().getByRole("button", { name: he.savebar.save }).click()
  await expect(page).toHaveURL(/\/notes\/[0-9a-f-]{36}$/)
  noteUrl = new URL(page.url()).pathname
  await expect(saveBar()).toHaveCount(0)
  await expect(versions()).toHaveCount(1)
  // A new note opens in Preview once saved: the Markdown heading is an h2 under the page's own title.
  await page.getByRole("button", { name: he.notes.preview }).click()
  await expect(page.locator(".ui-md h2")).toHaveText("Vents")
  await expect(page.locator(".ui-md strong")).toHaveText("north")
})

test("an edit adds a version; restoring the first makes it the newest, and Undo brings the edit back", async () => {
  await page.goto(noteUrl)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: he.notes.write }).click()
  await page.locator("#note-body").fill("# Vents\n\nOpen the north vents above 26 degrees.")
  await saveBar().getByRole("button", { name: he.savebar.save }).click()
  await expect(saveBar()).toHaveCount(0)
  await expect(versions()).toHaveCount(2)

  await versions().nth(1).click()
  const dialog = page.getByRole("dialog")
  await expect(dialog).toContainText("24")
  await dialog.getByRole("button", { name: he.notes.restore }).click()
  await expect(dialog).toHaveCount(0)
  await expect(versions()).toHaveCount(3)
  await page.getByRole("button", { name: he.notes.write }).click()
  await expect(page.locator("#note-body")).toHaveValue(/24 degrees/)

  await page.locator(".ui-toast").getByRole("button", { name: he.common.undo }).click()
  await expect(versions()).toHaveCount(4)
  await expect(page.locator("#note-body")).toHaveValue(/26 degrees/)
})

test("the list finds the note by its text and among the general notes", async () => {
  await page.goto(`/notes?q=${encodeURIComponent(run)}`)
  await page.waitForLoadState("networkidle")
  const row = page.locator("#notes .ui-note-row", { hasText: `Greenhouse vents ${run}` })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText("26 degrees")
  await page.goto(`/notes?general=true&q=${encodeURIComponent(run)}`)
  await expect(page.locator("#notes .ui-note-row")).toHaveCount(1)
  await row.click()
  await expect(page).toHaveURL(new RegExp(`${noteUrl}$`))
})

test("Delete asks first, then removes the note with its versions", async () => {
  await page.goto(noteUrl)
  await page.waitForLoadState("networkidle")
  await page.getByRole("button", { name: he.notes.delete }).click()
  const question = page.getByRole("alertdialog")
  await expect(question).toContainText(fill(he.notes.deleteTitle, { title: `Greenhouse vents ${run}` }))
  await question.getByRole("button", { name: he.notes.delete }).click()
  await expect(page).toHaveURL(/\/notes$/)
  await page.goto(noteUrl)
  await expect(page.getByText(he.notes.notFound)).toBeVisible()
})
