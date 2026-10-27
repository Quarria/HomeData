/** Explicit public entry points; never derive trust from forwarded headers. */
export function configuredAppOrigins(
  source: {
    APP_ORIGIN?: string | undefined;
    APP_ADDITIONAL_ORIGINS?: string | undefined;
  } = process.env,
) {
  return [
    source.APP_ORIGIN,
    ...(source.APP_ADDITIONAL_ORIGINS ?? "").split(","),
  ]
    .map((origin) => origin?.trim())
    .filter((origin): origin is string => Boolean(origin));
}
