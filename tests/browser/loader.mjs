const root = new URL('../../', import.meta.url);
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('/vendor/') || specifier.startsWith('/packages/sdk/')) return next(new URL(specifier.slice(1), root).href, context);
  return next(specifier, context);
}
