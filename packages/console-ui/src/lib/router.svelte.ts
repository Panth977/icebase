// Hash routes: #/firestore/users/u1 → { page: 'firestore', rest: 'users/u1' }.
function parse() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [page = 'overview', ...rest] = h.split('/');
  return { page: page || 'overview', rest: rest.join('/') };
}
export const route = $state(parse());
window.addEventListener('hashchange', () => Object.assign(route, parse()));
export const go = (page: string, rest = '') => (location.hash = `#/${page}${rest ? `/${rest.split('/').map(encodeURIComponent).join('/')}` : ''}`);
