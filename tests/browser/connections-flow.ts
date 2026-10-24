import { expect, type Page, type TestInfo } from "@playwright/test";
import type { Bookmark, BookmarkConnections } from "../../src/shared/bookmarks.ts";
import { transferFlow } from "./transfer-flow.ts";

/** Runs within the existing real session; no extra login or authentication shortcuts. */
export async function connectionsFlow(page: Page, testInfo: TestInfo, rootId: string, rootTitle: string) {
  const headers = { origin: "http://127.0.0.1:4187" };
  const read = async (id: string): Promise<Bookmark> => (await page.request.get(`/api/bookmarks/${id}`)).json();
  const group = async (): Promise<BookmarkConnections> => (await page.request.get(`/api/bookmarks/${rootId}/connections`)).json();
  const originalRoot = await read(rootId);
  const members: Bookmark[] = [];
  for (const [index, title] of ["[검증용] 月影 alternate · 다른 출처의 원래 제목", "[검증용] Archive companion · 별도로 보관한 출처"].entries()) {
    const response = await page.request.post("/api/bookmarks", { headers, data: {
      title, url: `https://www.zophar.net/music/snes/connection-${testInfo.project.name}-${index}.html`,
      note: `개인 원본 메모 ${index} · 연결해도 지우지 않습니다.`, favorite: false,
    } });
    expect(response.status()).toBe(201); members.push((await response.json()).item);
  }
  const [first, second] = members as [Bookmark, Bookmark];
  const card = page.getByRole("article", { name: rootTitle, exact: true });
  const dialog = page.getByRole("dialog", { name: "개인 출처 관리", exact: true });
  const choose = async (member: Bookmark) => {
    await dialog.getByRole("button", { name: `${member.title} 연결 선택`, exact: true }).click();
    await expect(dialog.getByRole("region", { name: "출처 변경 확인" })).toContainText("ID·제목·메모·즐겨찾기는 보관");
  };
  const connect = async (member: Bookmark, count: number) => {
    await choose(member);
    await dialog.getByRole("button", { name: "선택한 출처 연결", exact: true }).click();
    await expect(dialog.getByRole("heading", { name: `대표 북마크 ${count}개 출처`, exact: true })).toBeVisible();
  };
  await card.getByRole("button", { name: `${rootTitle} 출처 관리`, exact: true }).click();
  await connect(first, 2);
  await dialog.getByRole("button", { name: "방금 연결 되돌리기", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "대표 북마크 1개 출처", exact: true })).toBeVisible();
  expect((await read(first.id)).rootId).toBe(first.id);
  await connect(first, 2);
  await dialog.getByRole("button", { name: `${first.title} 연결 해제`, exact: true }).click();
  await dialog.getByRole("button", { name: "별도 북마크로 분리", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "대표 북마크 1개 출처", exact: true })).toBeVisible();
  expect(await read(first.id)).toMatchObject({ id: first.id, entityId: first.entityId, title: first.title,
    note: first.note, favorite: false, createdAt: first.createdAt, rootId: first.id });
  await dialog.getByRole("button", { name: "방금 해제 되돌리기", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "대표 북마크 2개 출처", exact: true })).toBeVisible();

  // A changed member invalidates the selected versions, without losing either record.
  await choose(second);
  expect((await page.request.patch(`/api/bookmarks/${second.id}`, { headers, data: {
    version: second.version, note: "다른 창에서 수정한 출처 메모",
  } })).ok()).toBe(true);
  await dialog.getByRole("button", { name: "선택한 출처 연결", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("다른 곳에서 수정");
  await expect(dialog.getByRole("button", { name: "선택한 출처 연결", exact: true })).toBeDisabled();
  expect((await group()).members).toHaveLength(1);
  await dialog.getByRole("button", { name: "최신 출처 불러오기", exact: true }).click();

  // An unknown network result must be re-read before another mutation is allowed.
  await choose(second);
  await page.route(`**/api/bookmarks/${rootId}/connections`, async (route) => {
    if (route.request().method() === "POST") await route.abort(); else await route.continue();
  });
  await dialog.getByRole("button", { name: "선택한 출처 연결", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("연결하지 못했습니다");
  expect((await group()).members).toHaveLength(1);
  await page.unroute(`**/api/bookmarks/${rootId}/connections`);
  await dialog.getByRole("button", { name: "최신 출처 불러오기", exact: true }).click();
  await connect(second, 3);
  await expect(dialog.getByRole("button", { name: `${first.title} 연결 선택`, exact: true })).toHaveCount(0);
  const firstSource = dialog.locator("li.connection-source").filter({ hasText: first.title });
  await firstSource.locator("summary").click();
  await expect(firstSource).toContainText(first.note);
  await expect(firstSource).toContainText("즐겨찾기 안 함");
  expect(await read(rootId)).toMatchObject({ id: rootId, entityId: originalRoot.entityId,
    title: originalRoot.title, note: originalRoot.note, favorite: originalRoot.favorite, createdAt: originalRoot.createdAt });
  expect((await (await page.request.post("/api/bookmarks", { headers, data: {
    title: "중복 입력은 원래 내용을 바꾸지 않음", url: first.url,
  } })).json())).toMatchObject({ created: false, item: { id: first.id, rootId, note: first.note } });
  await dialog.evaluate((element) => { element.scrollTop = 0; });
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("connections.png") });
  await dialog.getByRole("button", { name: "완료", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("connections-actions.png") });
  await dialog.getByRole("button", { name: "완료", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(card.getByRole("button", { name: "3개 출처 · 개인 연결", exact: true })).toBeVisible();
  await card.screenshot({ path: testInfo.outputPath("connections-card.png") });
  await transferFlow(page, testInfo, rootId);

  await page.getByLabel("내 북마크 검색").fill("月影");
  await page.getByRole("button", { name: "검색", exact: true }).click();
  await expect(page.getByRole("article")).toHaveCount(1);
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: `${rootTitle} 삭제`, exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("출처 관리에서 먼저 연결을 해제");
  await expect(page.getByRole("dialog").getByRole("button", { name: "삭제", exact: true })).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "출처 관리", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "대표 북마크 3개 출처", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "완료", exact: true }).click();

  // Leave the original item intact for the rest of the library/pagination scenario.
  for (const member of members) {
    const current = await group(), source = current.members.find((item) => item.id === member.id)!;
    const response = await page.request.delete(`/api/bookmarks/${rootId}/connections`, { headers, data: {
      version: current.root.version, memberId: source.id, memberVersion: source.version,
    } });
    expect(response.ok()).toBe(true);
    const result = await response.json();
    expect((await page.request.delete(`/api/bookmarks/${source.id}`, { headers, data: { version: result.detached.version } })).status()).toBe(204);
  }
  await page.reload();
  await expect(card).toBeVisible();
}
