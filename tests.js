const assert = require('assert');
const { _test } = require('./api/dashboard');
assert.equal(_test.parseNumber('1,579'), 1.579);
assert.equal(_test.normalizeText('GIJÓN'), 'GIJON');
const sample = { ListaEESSPrecio: [
  { IDEESS:'886', 'Rótulo':'EASYGAS', Municipio:'GIJÓN', Dirección:'Roces', PrecioProducto:'1,599' },
  { IDEESS:'2', 'Rótulo':'BARATA', Municipio:'Gijón', Dirección:'Centro', PrecioProducto:'1,499' },
  { IDEESS:'3', 'Rótulo':'OTRA', Municipio:'Oviedo', Dirección:'X', PrecioProducto:'1,399' }
]};
const picked = _test.pickFuel(sample);
assert.equal(picked.easygas.id, '886');
assert.equal(picked.cheapest.brand, 'BARATA');
assert.equal(_test.GAS_TUR.tariffs.length, 3);
assert.equal(_test.GAS_TUR.tariffs[0].id, 'TUR.1');
assert.equal(_test.GAS_TUR.validUntil, '2026-09-30');
console.log('OK: combustible, normalización y TUR de gas validados');
