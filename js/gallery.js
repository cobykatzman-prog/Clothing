export const REVIEW_STATES = Object.freeze({ draft: 'Draft', review: 'In review', approved: 'Approved' });

export function normalizeReview(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    status: Object.hasOwn(REVIEW_STATES, value.status) ? value.status : 'draft',
    reviewer: String(value.reviewer || ''),
    note: String(value.note || ''),
    updatedAt: Number(value.updatedAt) || 0,
  };
}

/** Apply gallery search and all active filters to an already sorted design list. */
export function filterDesigns(items, { query = '', tags = [], collection = '', review = '' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const selectedTags = [...tags].map(tag => String(tag).toLowerCase());
  return items.filter(item => {
    const reviewInfo = normalizeReview(item.review);
    const searchText = [
      item.name, item.collection, item.material?.name,
      reviewInfo.reviewer, reviewInfo.note, REVIEW_STATES[reviewInfo.status],
      ...(Array.isArray(item.tags) ? item.tags : []),
    ].join(' ').toLowerCase();
    const itemTags = Array.isArray(item.tags) ? item.tags : [];
    return (!q || searchText.includes(q))
      && selectedTags.every(tag => itemTags.some(value => String(value).toLowerCase() === tag))
      && (!collection || String(item.collection || '').trim() === collection)
      && (!review || reviewInfo.status === review);
  });
}

/** Reordering is safe only in an unfiltered custom-order gallery. */
export function canReorderDesigns({ sortKey, query = '', tags = [], collection = '', review = '', selectMode = false } = {}) {
  return sortKey === 'custom' && !String(query).trim() && [...tags].length === 0
    && !collection && !review && !selectMode;
}
