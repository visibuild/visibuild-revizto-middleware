import { afterEach, describe, expect, it } from "vitest";
import * as client from "../src/revizto/client";
import { ReviztoApiError } from "../src/revizto/client";
import { codeChallenge, ReviztoAuthError } from "../src/revizto/oauth";
import { regionHost, regionLabel } from "../src/revizto/types";
import { fakeEnv, fakeKv, freshTokens, stubFetch } from "./helpers";

const conn = { region: "sydney", clientId: "cid", clientSecret: "csecret" };

function connectedEnv() {
  return fakeEnv(fakeKv({ "revizto:tokens": freshTokens() }));
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe("regions", () => {
  it("resolves the host for a region", () => {
    expect(regionHost("sydney")).toBe("https://api.sydney.revizto.com");
    expect(regionLabel("ireland")).toBe("Europe (Ireland)");
  });

  it("falls back rather than building a broken URL for an unknown region", () => {
    expect(regionHost("atlantis")).toBe("https://api.sydney.revizto.com");
  });
});

describe("PKCE", () => {
  it("produces the S256 challenge from RFC 7636", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(await codeChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("the response envelope", () => {
  it("unwraps data when result is 0", async () => {
    const stub = stubFetch([{ result: 0, data: { email: "Sync@Example.com", firstname: "Sync", lastname: "Bot" } }]);
    restore = stub.restore;
    const user = await client.getCurrentUser(connectedEnv(), conn);
    expect(user.email).toBe("sync@example.com");
    expect(stub.calls[0].headers.authorization).toBe("Bearer test-access-token");
  });

  it("treats a negative result as an error even though the status is 200", async () => {
    const stub = stubFetch([{ result: -20, message: "Not enough rights" }]);
    restore = stub.restore;
    await expect(client.getCurrentUser(connectedEnv(), conn)).rejects.toBeInstanceOf(ReviztoApiError);
  });

  it("raises an auth error for a token result, so the UI can offer a reconnect", async () => {
    const stub = stubFetch([{ result: -206, message: "The access token is invalid" }]);
    restore = stub.restore;
    await expect(client.getCurrentUser(connectedEnv(), conn)).rejects.toBeInstanceOf(ReviztoAuthError);
  });

  it("refuses to call at all when Revizto is not connected", async () => {
    const stub = stubFetch([{ result: 0, data: {} }]);
    restore = stub.restore;
    await expect(client.getCurrentUser(fakeEnv(), conn)).rejects.toThrow(/not connected/i);
    expect(stub.calls).toHaveLength(0);
  });
});

describe("parseIssue", () => {
  it("unwraps each field's value envelope", () => {
    const issue = client.parseIssue({
      uuid: "abc",
      id: 7,
      updated: "2026-01-06 04:00:00",
      title: { value: "Cracked tile" },
      customStatus: { value: "status-uuid" },
      assignee: { value: "Jo@Sub.example" },
      tags: { value: ["Urgent"] },
      visibility: { value: 1 },
      priority: { value: "major" },
    });
    expect(issue).toEqual({
      uuid: "abc",
      id: 7,
      updated: "2026-01-06 04:00:00",
      fields: {
        title: "Cracked tile",
        customStatus: "status-uuid",
        assignee: "jo@sub.example",
        tags: ["Urgent"],
        visibility: 1,
        priority: "major",
      },
    });
  });

  it("omits fields Revizto did not send, rather than defaulting them", () => {
    // A field we default here would produce a wrong `old` in the next diff.
    const issue = client.parseIssue({ uuid: "abc", title: { value: "Only a title" } });
    expect(Object.keys(issue!.fields)).toEqual(["title"]);
  });

  it("returns null for a row with no uuid", () => {
    expect(client.parseIssue({ title: { value: "x" } })).toBeNull();
  });
});

describe("createIssue", () => {
  it("posts multipart with the integer project id and fields as JSON", async () => {
    const stub = stubFetch([{ result: 0, data: {} }]);
    restore = stub.restore;

    await client.createIssue(connectedEnv(), conn, {
      uuid: "11111111-1111-4111-8111-111111111111",
      projectId: 21,
      fields: {
        title: "Cracked tile",
        customStatus: "s-uuid",
        customType: "t-uuid",
        assignee: "jo@sub.example",
        reporter: "sam@builder.example",
        deadline: "2026-02-01 00:00:00",
        priority: "major",
        tags: ["Urgent"],
        visibility: 1,
      },
      created: "2026-01-05 02:30:00",
      location: { level: "Level 3", room: "Apartment 314", area: null, zone: null, space: null },
    });

    const call = stub.calls[0];
    expect(call.url).toBe("https://api.sydney.revizto.com/v5/issue/add");
    expect(call.method).toBe("POST");

    const form = call.body as FormData;
    expect(form.get("uuid")).toBe("11111111-1111-4111-8111-111111111111");
    expect(form.get("projectId")).toBe("21");

    const fields = JSON.parse(String(form.get("fields")));
    expect(fields.title).toEqual({ value: "Cracked tile" });
    expect(fields.created).toEqual({ value: "2026-01-05 02:30:00" });
    expect(fields.locationPropertiesJson.room).toBe("Apartment 314");
  });

  it("omits an assignee, reporter or deadline it cannot fill", async () => {
    const stub = stubFetch([{ result: 0, data: {} }]);
    restore = stub.restore;

    await client.createIssue(connectedEnv(), conn, {
      uuid: "11111111-1111-4111-8111-111111111111",
      projectId: 21,
      fields: {
        title: "No assignee",
        customStatus: "s",
        customType: "t",
        assignee: "",
        reporter: "",
        deadline: "",
        priority: "none",
        tags: [],
        visibility: 1,
      },
    });

    const fields = JSON.parse(String((stub.calls[0].body as FormData).get("fields")));
    expect(fields).not.toHaveProperty("assignee");
    expect(fields).not.toHaveProperty("reporter");
    expect(fields).not.toHaveProperty("deadline");
    expect(fields).not.toHaveProperty("locationPropertiesJson");
  });
});

describe("addComments", () => {
  it("sends a diff comment with old/new pairs", async () => {
    const stub = stubFetch([{ result: 0, data: {} }]);
    restore = stub.restore;

    await client.addComments(connectedEnv(), conn, {
      projectUuid: "p-uuid",
      projectId: 21,
      issueUuid: "i-uuid",
      comments: [
        {
          kind: "diff",
          uuid: "22222222-2222-4222-8222-222222222222",
          diff: { title: { old: "Was", new: "Now" } },
          reporter: "sam@builder.example",
        },
      ],
    });

    const form = stub.calls[0].body as FormData;
    expect(stub.calls[0].url).toBe("https://api.sydney.revizto.com/v5/comment/add");
    expect(form.get("projectUuid")).toBe("p-uuid");
    expect(form.get("projectId")).toBe("21");
    const comments = JSON.parse(String(form.get("comments")));
    expect(comments[0]).toMatchObject({ type: "diff", diff: { title: { old: "Was", new: "Now" } } });
  });

  it("attaches a file under the part name Revizto expects", async () => {
    const stub = stubFetch([{ result: 0, data: {} }]);
    restore = stub.restore;
    const uuid = "33333333-3333-4333-8333-333333333333";

    await client.addComments(connectedEnv(), conn, {
      projectUuid: "p-uuid",
      projectId: 21,
      issueUuid: "i-uuid",
      comments: [{ kind: "file", uuid, filename: "photo.jpg", blob: new Blob(["bytes"]) }],
    });

    const form = stub.calls[0].body as FormData;
    expect(form.get(`file_${uuid}`)).toBeInstanceOf(File);
    expect(JSON.parse(String(form.get("comments")))[0].type).toBe("file");
  });

  it("makes no request when there is nothing to say", async () => {
    const stub = stubFetch([{ result: 0, data: {} }]);
    restore = stub.restore;
    await client.addComments(connectedEnv(), conn, {
      projectUuid: "p",
      projectId: 1,
      issueUuid: "i",
      comments: [],
    });
    expect(stub.calls).toHaveLength(0);
  });
});

describe("sweepIssues", () => {
  it("pages through the filter endpoint and returns the next watermark", async () => {
    const stub = stubFetch([
      {
        result: 0,
        data: {
          data: [{ uuid: "a", title: { value: "A" } }],
          pages: 2,
          synchronized: "2026-01-06 04:00:00",
        },
      },
      {
        result: 0,
        data: {
          data: [{ uuid: "b", title: { value: "B" } }],
          pages: 2,
          synchronized: "2026-01-06 04:00:00",
        },
      },
    ]);
    restore = stub.restore;

    const sweep = await client.sweepIssues(connectedEnv(), conn, "p-uuid", "2026-01-01 00:00:00");
    expect(sweep.issues.map((i) => i.uuid)).toEqual(["a", "b"]);
    expect(sweep.synchronized).toBe("2026-01-06 04:00:00");
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[0].url).toContain("synchronized=2026-01-01+00%3A00%3A00");
    expect(stub.calls[0].url).toContain("sendFullIssueData=true");
  });

  it("omits the watermark on a first sweep, so the whole project comes back", async () => {
    const stub = stubFetch([{ result: 0, data: { data: [], pages: 1, synchronized: "2026-01-06 04:00:00" } }]);
    restore = stub.restore;
    await client.sweepIssues(connectedEnv(), conn, "p-uuid", null);
    expect(stub.calls[0].url).not.toContain("synchronized");
  });
});
