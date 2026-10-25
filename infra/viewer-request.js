// CloudFront Function (cloudfront-js-2.0), viewer-request, for the CAFF static export.
// 1. Every dynamic id is served by the page prerendered for "_":
//    /dashboard/matches/<id>/...        -> /dashboard/matches/_/...
//    /dashboard/admin/matches/<id>/...  -> /dashboard/admin/matches/_/...
//    /dashboard/player/<id>/...         -> /dashboard/player/_/...
//    (also covers the RSC payload files the client router fetches on navigation)
// 2. Directory URLs map to index.html; extensionless URLs redirect to the trailing-slash form.
// 0. Every other hostname (www.caffleague.com, caff.anaysprojects.com, the cloudfront.net name) redirects
//    permanently to https://caffleague.com with the same path and query.
var CANONICAL_HOST = 'caffleague.com';
var DYNAMIC = /^\/dashboard\/(admin\/matches|matches|player)\/([^\/.]+)(\/.*)?$/;

function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var host = request.headers.host ? request.headers.host.value : '';
  var qs = request.querystring && Object.keys(request.querystring).length
    ? '?' + Object.keys(request.querystring).map(function (k) {
        var v = request.querystring[k];
        return encodeURIComponent(k) + (v && v.value !== undefined && v.value !== '' ? '=' + encodeURIComponent(v.value) : '');
      }).join('&')
    : '';
  if (host && host !== CANONICAL_HOST) {
    return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: 'https://' + CANONICAL_HOST + uri + qs } } };
  }
  var m = uri.match(DYNAMIC);
  if (m && m[2] !== '_' && m[3]) {
    uri = '/dashboard/' + m[1] + '/_' + m[3];
  }
  if (uri.endsWith('/')) {
    request.uri = uri + 'index.html';
    return request;
  }
  var last = uri.substring(uri.lastIndexOf('/') + 1);
  if (last.indexOf('.') === -1) {
    return { statusCode: 301, statusDescription: 'Moved Permanently', headers: { location: { value: request.uri + '/' + qs } } };
  }
  request.uri = uri;
  return request;
}

if (typeof module !== 'undefined') module.exports = { handler };
