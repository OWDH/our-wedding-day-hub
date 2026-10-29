// The registration label predates the category slug array. Only infer an
// unambiguous Magician selection; an explicit array (including []) is final.
export function withRegistrationCategories(vendor) {
  if (Array.isArray(vendor.categories) || vendor.category ||
      String(vendor.primaryCategory || '').trim().toLowerCase() !== 'magician') return vendor;
  return { ...vendor, categories: ['magician'] };
}
