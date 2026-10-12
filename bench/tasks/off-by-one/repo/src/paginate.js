/** Return one page of `items`. Pages are 1-based. */
export function paginate(items, page, perPage) {
  const start = page * perPage;
  return {
    items: items.slice(start, start + perPage),
    page,
    totalPages: Math.floor(items.length / perPage),
  };
}
