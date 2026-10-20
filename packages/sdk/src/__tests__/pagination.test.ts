import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  normalizePaginationLimit,
  paginateArray,
  paginateQuery,
  iteratePages,
  type PaginatedResult,
} from "../utils/pagination.js";

describe("pagination helpers", () => {
  describe("normalizePaginationLimit", () => {
    it("returns DEFAULT_PAGE_LIMIT when undefined or null", () => {
      expect(normalizePaginationLimit(undefined)).toBe(DEFAULT_PAGE_LIMIT);
      expect(normalizePaginationLimit(null as unknown as number)).toBe(DEFAULT_PAGE_LIMIT);
      expect(normalizePaginationLimit(NaN)).toBe(DEFAULT_PAGE_LIMIT);
    });

    it("clamps negative and zero limits to 1", () => {
      expect(normalizePaginationLimit(0)).toBe(1);
      expect(normalizePaginationLimit(-10)).toBe(1);
    });

    it("clamps values exceeding MAX_PAGE_LIMIT", () => {
      expect(normalizePaginationLimit(500)).toBe(MAX_PAGE_LIMIT);
    });

    it("floors decimal inputs", () => {
      expect(normalizePaginationLimit(15.8)).toBe(15);
    });
  });

  describe("paginateArray", () => {
    const items = [
      { id: 1, name: "A" },
      { id: 2, name: "B" },
      { id: 3, name: "C" },
      { id: 4, name: "D" },
      { id: 5, name: "E" },
    ];
    const getCursor = (item: (typeof items)[0]) => item.id;

    it("returns first page with default or specified limit", () => {
      const page1 = paginateArray(items, { limit: 2 }, getCursor);
      expect(page1.items).toEqual([{ id: 1, name: "A" }, { id: 2, name: "B" }]);
      expect(page1.nextCursor).toBe(2);
      expect(page1.hasMore).toBe(true);
      expect(page1.total).toBe(5);
    });

    it("continues from a valid cursor", () => {
      const page2 = paginateArray(items, { limit: 2, cursor: 2 }, getCursor);
      expect(page2.items).toEqual([{ id: 3, name: "C" }, { id: 4, name: "D" }]);
      expect(page2.nextCursor).toBe(4);
      expect(page2.hasMore).toBe(true);
    });

    it("terminates on the last page with hasMore: false", () => {
      const page3 = paginateArray(items, { limit: 2, cursor: 4 }, getCursor);
      expect(page3.items).toEqual([{ id: 5, name: "E" }]);
      expect(page3.nextCursor).toBeUndefined();
      expect(page3.hasMore).toBe(false);
    });

    it("returns empty result on invalid cursor", () => {
      const page = paginateArray(items, { limit: 2, cursor: 999 }, getCursor);
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeUndefined();
      expect(page.hasMore).toBe(false);
    });
  });

  describe("paginateQuery", () => {
    it("delegates to fetchPage and enforces normalized limit", async () => {
      const fetchPage = vi.fn().mockResolvedValue({
        items: [1, 2, 3],
        nextCursor: 3,
        hasMore: true,
      });

      const res = await paginateQuery(fetchPage, { limit: 250, cursor: 10 });
      expect(fetchPage).toHaveBeenCalledWith(10, MAX_PAGE_LIMIT);
      expect(res.items).toHaveLength(3);
      expect(res.hasMore).toBe(true);
    });

    it("prevents infinite loops when provider returns repeated cursor", async () => {
      const fetchPage = vi.fn().mockResolvedValue({
        items: [1, 2],
        nextCursor: 5,
        hasMore: true,
      });

      const res = await paginateQuery(fetchPage, { cursor: 5 });
      // Same cursor returned -> circular loop guard clears cursor and ends continuation
      expect(res.nextCursor).toBeUndefined();
      expect(res.hasMore).toBe(false);
    });
  });

  describe("iteratePages", () => {
    it("walks pages until hasMore is false", async () => {
      const mockPages: Record<string, PaginatedResult<number, string>> = {
        initial: { items: [1, 2], nextCursor: "p2", hasMore: true },
        p2: { items: [3, 4], nextCursor: "p3", hasMore: true },
        p3: { items: [5], nextCursor: undefined, hasMore: false },
      };

      const fetchPage = vi.fn().mockImplementation(async (cursor?: string) => {
        return mockPages[cursor || "initial"];
      });

      const collected: number[][] = [];
      for await (const page of iteratePages(fetchPage)) {
        collected.push(page);
      }

      expect(collected).toEqual([[1, 2], [3, 4], [5]]);
      expect(fetchPage).toHaveBeenCalledTimes(3);
    });

    it("stops on empty page result", async () => {
      const fetchPage = vi.fn().mockResolvedValue({
        items: [],
        nextCursor: "never",
        hasMore: true,
      });

      const collected: number[][] = [];
      for await (const page of iteratePages(fetchPage)) {
        collected.push(page);
      }

      expect(collected).toEqual([]);
      expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it("breaks loop on repeated cursor", async () => {
      const fetchPage = vi.fn().mockResolvedValue({
        items: [1],
        nextCursor: "loop",
        hasMore: true,
      });

      const collected: number[][] = [];
      for await (const page of iteratePages(fetchPage, { cursor: "loop" })) {
        collected.push(page);
      }

      expect(collected).toHaveLength(1);
    });
  });
});
