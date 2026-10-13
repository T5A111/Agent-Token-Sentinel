/** Return one page of `items`. Pages are 1-based. */
export function paginate(items, page, perPage) {
  const start = (page - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    page,
    totalPages: Math.ceil(items.length / perPage),
  };
}
