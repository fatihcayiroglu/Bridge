// server/routes/admin.ts
// Bu dosya geriye dönük uyumluluk için korunmaktadır.
// Gerçek implementasyon: server/routes/admin/ (core.ts + federation-acl.ts + sfu.ts)
//
// require('../routes/admin')                    → router
// require('../routes/admin').checkFederationACL → ACL fonksiyonu

export { default } from './admin/index';
export * from './admin/index';
