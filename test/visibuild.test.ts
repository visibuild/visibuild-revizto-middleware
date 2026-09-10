import { afterEach, describe, expect, it } from "vitest";
import {
  appUrlFromApiUrl,
  parseLocationClosures,
  parseLocations,
  parseProjectAttachments,
  parseProjectCompanies,
  parseProjectUsers,
  parseUsers,
  parseVisiRequirements,
  parseVisiStatusChanges,
  parseVisiTags,
  parseVisis,
  resetTokenCache,
  tokenUrlFromApiUrl,
  VisibuildError,
  isRateLimited,
} from "../src/visibuild/client";
import { attachmentFilename, AttachmentSkipped, fetchAttachment } from "../src/sync/attachments";

afterEach(() => resetTokenCache());

describe("URL derivation", () => {
  it("derives the token endpoint from the API base URL", () => {
    expect(tokenUrlFromApiUrl("https://app.apac.visibuild.com/api/core/v1")).toBe(
      "https://app.apac.visibuild.com/oauth/token",
    );
    expect(tokenUrlFromApiUrl("https://app.eu.visibuild.com/api/core/v1/")).toBe(
      "https://app.eu.visibuild.com/oauth/token",
    );
  });

  it("derives the web app origin, for deep links back to a visi", () => {
    expect(appUrlFromApiUrl("https://app.apac.visibuild.com/api/core/v1")).toBe("https://app.apac.visibuild.com");
  });
});

describe("parseVisis", () => {
  it("reads the documented visi shape", () => {
    const visis = parseVisis({
      data: {
        visis: [
          {
            id: "v1",
            isRoot: true,
            alias: "VIS-1",
            title: "Visi 1",
            description: "Description",
            type: "inspection",
            category: "inspection",
            subtypeId: null,
            status: "open",
            projectId: "p1",
            locationId: "l1",
            defectRoundId: null,
            projectMilestoneId: "pm1",
            assigneeId: "pu1",
            assigneeType: "ProjectUser",
            createdByProjectUserId: "pu1",
            replacedByVisiId: null,
            projectAttachmentIds: ["a1", "a2"],
            dueDate: "2026-01-15",
            createdAt: "2026-01-01T02:00:00Z",
            updatedAt: "2026-01-02T02:00:00Z",
            archived: false,
          },
        ],
      },
    });
    expect(visis).toHaveLength(1);
    expect(visis[0]).toMatchObject({
      id: "v1",
      alias: "VIS-1",
      status: "open",
      assigneeType: "ProjectUser",
      projectAttachmentIds: ["a1", "a2"],
      archived: false,
    });
  });

  it("also accepts snake_case, which the API has served historically", () => {
    const [visi] = parseVisis({
      data: {
        visis: [
          {
            id: "v1",
            title: "t",
            status: "open",
            is_root: true,
            project_id: "p1",
            location_id: "l1",
            assignee_id: "pu1",
            assignee_type: "ProjectCompany",
            created_by_project_user_id: "pu2",
            project_attachment_ids: ["a1"],
            due_date: "2026-01-15",
            updated_at: "2026-01-02T02:00:00Z",
          },
        ],
      },
    });
    expect(visi).toMatchObject({
      isRoot: true,
      projectId: "p1",
      assigneeType: "ProjectCompany",
      createdByProjectUserId: "pu2",
      projectAttachmentIds: ["a1"],
      dueDate: "2026-01-15",
    });
  });

  it("returns an empty list for an empty or malformed response", () => {
    expect(parseVisis({})).toEqual([]);
    expect(parseVisis({ data: { visis: [{ title: "no id" }] } })).toEqual([]);
  });
});

describe("supporting parsers", () => {
  it("parses locations and their closure rows", () => {
    expect(parseLocations({ data: { locations: [{ id: "l1", name: "Level 1", projectId: "p1" }] } })).toEqual([
      { id: "l1", name: "Level 1", projectId: "p1" },
    ]);
    expect(
      parseLocationClosures({ data: { locationClosures: [{ ancestorId: "a", descendantId: "d", depth: 2, order: -1 }] } }),
    ).toEqual([{ ancestorId: "a", descendantId: "d", depth: 2, order: -1 }]);
  });

  it("parses project members and companies", () => {
    expect(
      parseProjectUsers({ data: { projectUsers: [{ id: "pu1", userId: "u1", projectCompanyId: "pc1", active: true }] } }),
    ).toEqual([{ id: "pu1", projectId: null, userId: "u1", projectCompanyId: "pc1", active: true }]);
    expect(parseProjectCompanies({ data: { projectCompanies: [{ id: "pc1", companyId: "c1" }] } })).toEqual([
      { id: "pc1", projectId: null, companyId: "c1", active: true },
    ]);
  });

  it("lower-cases user emails, since they are the join key with Revizto", () => {
    const [user] = parseUsers({ data: { users: [{ id: "u1", name: "Sam", email: " Sam@Builder.Example " }] } });
    expect(user.email).toBe("sam@builder.example");
  });

  it("builds a full name from first and last when there is no name field", () => {
    const [user] = parseUsers({ data: { users: [{ id: "u1", first_name: "Jo", last_name: "Chen", email: "jo@x.com" }] } });
    expect(user.name).toBe("Jo Chen");
  });

  it("parses visi tags, requirements and status changes", () => {
    expect(parseVisiTags({ data: { visiTags: [{ visiId: "v1", tagId: "t1" }] } })).toEqual([
      { visiId: "v1", tagId: "t1" },
    ]);
    const [req] = parseVisiRequirements({
      data: {
        visiRequirements: [
          { id: "r1", visiId: "v1", type: "multi_choice", order: 1, title: "Trades", value: null, choices: ["A", "B"], allowMultiple: true, values: ["A"] },
        ],
      },
    });
    expect(req).toMatchObject({ type: "multi_choice", choices: ["A", "B"], allowMultiple: true, values: ["A"] });
    const [change] = parseVisiStatusChanges({
      data: { visiStatusChanges: [{ id: "c1", visiId: "v1", event: "closed", statusBefore: "open", statusAfter: "closed", timestamp: "2026-01-06T04:00:00Z" }] },
    });
    expect(change).toMatchObject({ statusBefore: "open", statusAfter: "closed" });
  });

  it("ignores attachments with no URL", () => {
    const attachments = parseProjectAttachments({
      data: { projectAttachments: [{ id: "a1", url: "https://cdn/x.jpg", title: "Photo" }, { id: "a2" }] },
    });
    expect(attachments.map((a) => a.id)).toEqual(["a1"]);
  });
});

describe("rate limiting", () => {
  it("recognises a 429 so the caller can back off rather than retry", () => {
    expect(isRateLimited(new VisibuildError("too many", 429))).toBe(true);
    expect(isRateLimited(new VisibuildError("bad request", 400))).toBe(false);
    expect(isRateLimited(new Error("something else"))).toBe(false);
  });
});

describe("attachment filenames", () => {
  it("takes the name from the URL path", () => {
    expect(attachmentFilename("https://cdn.example/files/photo%20one.jpg?sig=abc", "Photo")).toBe("photo one.jpg");
  });

  it("falls back to the title for an extensionless signed URL", () => {
    expect(attachmentFilename("https://cdn.example/8f3a2b1c", "Site photo")).toBe("8f3a2b1c");
    expect(attachmentFilename("https://cdn.example/", "Site: photo")).toBe("Site- photo");
  });
});

describe("fetchAttachment", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("refuses a file type Revizto will not accept, without downloading it", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("x");
    }) as typeof fetch;
    await expect(fetchAttachment("https://cdn.example/tool.exe", "Tool", 10_000_000)).rejects.toBeInstanceOf(
      AttachmentSkipped,
    );
    expect(called).toBe(false);
  });

  it("refuses a file the HEAD response says is over the cap", async () => {
    globalThis.fetch = (async (_url: any, init: any = {}) =>
      init.method === "HEAD"
        ? new Response(null, { headers: { "content-length": "50000000" } })
        : new Response("bytes")) as typeof fetch;
    await expect(fetchAttachment("https://cdn.example/big.jpg", "Big", 1_000_000)).rejects.toThrow(/over the/);
  });

  it("downloads a file within the cap", async () => {
    globalThis.fetch = (async (_url: any, init: any = {}) =>
      init.method === "HEAD"
        ? new Response(null, { headers: { "content-length": "5" } })
        : new Response("bytes", { headers: { "content-type": "image/jpeg" } })) as typeof fetch;
    const file = await fetchAttachment("https://cdn.example/small.jpg", "Small", 1_000_000);
    expect(file.filename).toBe("small.jpg");
    expect(file.blob.size).toBe(5);
  });

  it("still checks the size after downloading, when HEAD is not allowed", async () => {
    globalThis.fetch = (async (_url: any, init: any = {}) => {
      if (init.method === "HEAD") throw new Error("HEAD not allowed");
      return new Response("x".repeat(100));
    }) as typeof fetch;
    await expect(fetchAttachment("https://cdn.example/x.jpg", "X", 10)).rejects.toBeInstanceOf(AttachmentSkipped);
  });
});
