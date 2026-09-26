// server/tests/upload-storage-topology.test.ts
//
// Final21 Faz 10 — F21-10-02. İki gerçek Bridge örneği (aynı PostgreSQL + Redis,
// örnek başına ayrı yükleme kökü) önünde ÖLÇÜLDÜ: örnek A'ya yüklenen avatar
// örnek B'de 404 döndü, B ise aynı URL'yi kullanıcıya veriyordu. Dağıtım
// `BRIDGE_MULTI_NODE=true` ilan ettiğinde düğüme yerel depolama açılışta
// reddedilmelidir.

import { sharedUploadStorageProblem } from '../lib/uploadStorageTopology';

describe('çok düğümlü dağıtımda yükleme deposu topolojisi', () => {
  it('bildirim yoksa (tek düğüm) hiçbir şey reddedilmez', () => {
    expect(sharedUploadStorageProblem({})).toBeNull();
    expect(sharedUploadStorageProblem({ BRIDGE_MULTI_NODE: 'false' })).toBeNull();
  });

  it('çok düğüm + varsayılan yerel depolama REDDEDİLİR ve iki ayarı da adlandırır', () => {
    const problem = sharedUploadStorageProblem({ BRIDGE_MULTI_NODE: 'true' });
    expect(problem).toMatch(/CDN_PROVIDER=local/);
    expect(problem).toMatch(/PRIVATE_STORAGE_PROVIDER=local/);
  });

  it('yalnızca genel CDN uzak olsa bile korumalı ekler yerel kaldığı için REDDEDİLİR', () => {
    const problem = sharedUploadStorageProblem({ BRIDGE_MULTI_NODE: 'true', CDN_PROVIDER: 'r2' });
    expect(problem).not.toMatch(/CDN_PROVIDER=r2/);
    expect(problem).toMatch(/PRIVATE_STORAGE_PROVIDER=local/);
  });

  it('bilinmeyen sağlayıcı adı uzak sayılmaz', () => {
    expect(sharedUploadStorageProblem({ BRIDGE_MULTI_NODE: 'true', CDN_PROVIDER: 'ftp', PRIVATE_STORAGE_PROVIDER: 'ftp' }))
      .toMatch(/CDN_PROVIDER=ftp/);
  });

  it.each(['s3', 'r2', 'minio', 'b2', 'MinIO'])('genel + özel %s kabul edilir', (provider) => {
    expect(sharedUploadStorageProblem({
      BRIDGE_MULTI_NODE: 'TRUE', CDN_PROVIDER: provider, PRIVATE_STORAGE_PROVIDER: provider,
    })).toBeNull();
  });
});
