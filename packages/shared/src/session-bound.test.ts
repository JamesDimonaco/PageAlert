import { describe, expect, it } from "vitest";
import { sessionBoundParams } from "./session-bound";

describe("sessionBoundParams", () => {
  it("flags the CSRF token on the embassy calendar link that never loaded", () => {
    const url = "https://evisaforms.state.gov/acs/make_calendar.asp?CSRFToken=9f8e7d6c5b4a&pc=KWT";
    expect(sessionBoundParams(url)).toEqual(["CSRFToken"]);
  });

  it("flags the signature params on a presigned S3 link", () => {
    const url =
      "https://bucket.s3.eu-west-2.amazonaws.com/file.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256" +
      "&X-Amz-Credential=AKIA%2F20260926%2Feu-west-2%2Fs3%2Faws4_request&X-Amz-Date=20260926T120000Z" +
      "&X-Amz-Expires=3600&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123";
    expect(sessionBoundParams(url)).toEqual(["X-Amz-Credential", "X-Amz-Signature"]);
  });

  it("flags a CloudFront signed link", () => {
    const url = "https://d111.cloudfront.net/page.html?Expires=1790000000&Signature=abc&Key-Pair-Id=K2";
    expect(sessionBoundParams(url)).toEqual(["Expires", "Signature"]);
  });

  it("matches keys case-insensitively and reports them as the user typed them", () => {
    const url = "https://shop.example.com/cart?JSESSIONID=1&phpSessId=2&SessionID=3&Authenticity_Token=4";
    expect(sessionBoundParams(url)).toEqual(["JSESSIONID", "phpSessId", "SessionID", "Authenticity_Token"]);
  });

  it("names a repeated key once", () => {
    expect(sessionBoundParams("https://example.com/?token=a&token=b")).toEqual(["token"]);
  });

  it("leaves a plain product or listing link alone", () => {
    expect(sessionBoundParams("https://www.amazon.co.uk/dp/B0CHX1W1XY?th=1&psc=1")).toEqual([]);
    expect(sessionBoundParams("https://example.com/shop?page=2&sort=price")).toEqual([]);
  });

  it("matches whole keys, not substrings", () => {
    expect(sessionBoundParams("https://example.com/?sidebar=1&token_type=bearer&csrf_hint=x")).toEqual([]);
  });

  it("ignores the fragment", () => {
    expect(sessionBoundParams("https://example.com/page#token=abc")).toEqual([]);
  });

  it("returns nothing for text that is not a URL yet", () => {
    expect(sessionBoundParams("")).toEqual([]);
    expect(sessionBoundParams("evisaforms.state")).toEqual([]);
  });
});
