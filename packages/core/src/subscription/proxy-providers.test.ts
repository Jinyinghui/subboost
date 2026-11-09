import { describe, expect, it } from "vitest";
import {
  buildProxyProvidersFromConfig,
  resolveProxyProviderName,
  resolveProxyProviderPath,
} from "./proxy-providers";

describe("proxy provider config builder", () => {
  it("returns undefined when no URL source can safely become a provider", () => {
    expect(buildProxyProvidersFromConfig({}, { testUrl: "https://test.example.com", testInterval: 60 })).toBeUndefined();
    expect(
      buildProxyProvidersFromConfig(
        {
          sources: [
            null,
            "bad",
            { type: "text", useProxyProviders: true, content: "https://example.com/sub" },
            { type: "url", useProxyProviders: false, content: "https://example.com/sub" },
            { type: "url", useProxyProviders: true, content: "" },
            { type: "url", useProxyProviders: true, content: "ftp://example.com/sub" },
            { type: "url", useProxyProviders: true, content: 123 as unknown as string },
          ],
        },
        { testUrl: "https://test.example.com", testInterval: 60 }
      )
    ).toBeUndefined();
  });

  it("names provider names sequentially and defaults URL sources to provider mode", () => {
    const providers = buildProxyProvidersFromConfig(
      {
        sources: [
          { id: "airport one", type: "url", useProxyProviders: true, content: " https://a.example.com/sub " },
          { type: "url", content: "https://b.example.com/sub" },
          { id: "bad/url", type: "url", useProxyProviders: false, content: "https://c.example.com/sub" },
          { type: "url", useProxyProviders: true, content: "https://d.example.com/sub" },
        ],
      },
      { testUrl: "https://test.example.com", testInterval: 120 }
    );

    expect(providers).toMatchObject({
      my_sub: {
        type: "http",
        url: "https://a.example.com/sub",
        interval: 3600,
        path: "./proxies/my_sub.yaml",
        "health-check": {
          enable: true,
          url: "https://test.example.com",
          interval: 120,
        },
      },
      my_sub_2: {
        type: "http",
        url: "https://b.example.com/sub",
      },
      my_sub_3: {
        type: "http",
        url: "https://d.example.com/sub",
      },
    });
    expect(Object.keys(providers || {})).toEqual(["my_sub", "my_sub_2", "my_sub_3"]);
  });

  it("resolves provider names and paths", () => {
    expect(resolveProxyProviderName(0)).toBe("my_sub");
    expect(resolveProxyProviderName(1)).toBe("my_sub_2");
    expect(resolveProxyProviderName(2)).toBe("my_sub_3");
    expect(resolveProxyProviderPath("my_sub")).toBe("./proxies/my_sub.yaml");
    expect(resolveProxyProviderPath("my_sub_2")).toBe("./proxies/my_sub_2.yaml");
  });
});
