export function appOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.port && url.port !== "443")
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new Error("invalid_app_url");
  }
}
