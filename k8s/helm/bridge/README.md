# Bridge Helm Chart

Sprint 118'de eklendi — ham k8s YAML manifest'lerine ek olarak Helm tabanlı kurulum.

## Gereksinimler

- Kubernetes 1.26+
- Helm 3.12+
- `cert-manager` (TLS için)
- `prometheus-operator` (ServiceMonitor için, opsiyonel)

## Hızlı Kurulum

```bash
# Bitnami repo (postgresql + redis bağımlılıkları)
helm repo add bitnami https://charts.bitnami.com/bitnami
helm repo update

# Bağımlılıkları indir
helm dependency update ./k8s/helm/bridge

# Namespace oluştur
kubectl create namespace bridge

# Veri deposu parolaları — çizelge bunları VAR OLAN Secret'lardan okur (Final21 Faz 19).
# PostgreSQL: Bitnami alt çizelgesi ve Bridge'in DATABASE_URL'i aynı anahtarı kullanır.
kubectl -n bridge create secret generic bridge-db-secret \
  --from-literal=password="$(openssl rand -hex 32)" \
  --from-literal=postgres-password="$(openssl rand -hex 32)"
# Redis: parolasız Redis kurulmaz (redis.auth.enabled=true); Bridge'in REDIS_URL'i onu taşır.
kubectl -n bridge create secret generic bridge-redis-secret \
  --from-literal=redis-password="$(openssl rand -hex 32)"

# Kurulum (development — TEK replika, yerel yükleme deposu)
helm install bridge ./k8s/helm/bridge \
  --namespace bridge \
  --set replicaCount=1 \
  --set autoscaling.enabled=false \
  --set secrets.JWT_SECRET="$(openssl rand -hex 32)" \
  --set secrets.REFRESH_SECRET="$(openssl rand -hex 32)"

# Kurulum (production — values dosyasıyla; paylaşılan yükleme deposu ZORUNLU)
helm install bridge ./k8s/helm/bridge \
  --namespace bridge \
  -f k8s/helm/bridge/values-production.yaml
```

> **Yükleme deposu (Final21 Faz 10 — F21-10-02).** Varsayılan değerler 2+ replika
> ve HPA çalıştırır; yükleme deposu ise varsayılan olarak pod'a yerel diskir.
> İki gerçek Bridge örneği önünde ölçüldü: bir pod'a yüklenen dosya diğerinde
> 404 döndü ve pod yeniden başlayınca kaybolur. Şema bu yapılandırmayı **render
> anında reddeder**. Kabul edilen yollar:
> 1. `env.CDN_PROVIDER` **ve** `env.PRIVATE_STORAGE_PROVIDER` = `s3|r2|minio|b2`
>    (ikisi de gerekir; korumalı ekler genel CDN uzak olsa bile ayrıca yerel kalır),
> 2. `persistence.enabled=true` ve `persistence.accessMode=ReadWriteMany`,
> 3. `replicaCount=1` ve `autoscaling.enabled=false`.
>
> **Oturum yapışkanlığı (F21-10-01).** Ingress çerez yapışkanlığı taşır; WebSocket
> engellenip uzun yoklamaya düşen istemciler yapışkanlık olmadan çok replikada hiç
> bağlanamıyordu (ölçüldü: 86 × "Session ID unknown"). Kendi ingress'inizi
> kullanıyorsanız eşdeğer yapışkanlığı sağlayın.

## Üretim values-production.yaml Örneği

```yaml
image:
  repository: ghcr.io/your-org/bridge
  # tag boş bırakılırsa Chart.appVersion kullanılır (sürümle eşli).
  tag: ""

# Çok replikada ZORUNLU: paylaşılan yükleme deposu (F21-10-02).
# Kimlik bilgileri (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, ...) secrets altında verilir.
env:
  NODE_ENV: production
  PORT: "3001"
  CDN_PROVIDER: r2
  PRIVATE_STORAGE_PROVIDER: r2

ingress:
  hosts:
    - host: bridge.yourdomain.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: bridge-tls
      hosts:
        - bridge.yourdomain.com

postgresql:
  enabled: false  # Harici managed DB kullan

redis:
  enabled: false  # Harici managed Redis kullan — maxmemory-policy MUTLAKA noeviction
                  # (F21-10-03: evicting politika hız sınırını aşılabilir kılar;
                  #  ölçüldü. Birçok yönetilen Redis varsayılanı volatile-lru'dur.)

secrets:
  JWT_SECRET: ""           # CI/CD'den inject et
  REFRESH_SECRET: ""
  DATABASE_URL: ""
  REDIS_URL: ""
```

## Güncelleme

```bash
helm upgrade bridge ./k8s/helm/bridge --namespace bridge -f values-production.yaml
```

## Kaldırma

```bash
helm uninstall bridge --namespace bridge
```

> **Not:** PVC'ler ve Secret'lar `helm.sh/resource-policy: keep` annotation'ı nedeniyle
> `helm uninstall` sonrası silinmez. Manuel silim: `kubectl delete pvc,secret -n bridge -l app.kubernetes.io/instance=bridge`

## Veri depolarına erişim (Final21 Faz 19 — F21-10-04)

- Redis parolası `bridge-redis-secret/redis-password`tan gelir; `REDIS_URL` bunu `$(REDIS_PASSWORD)` ile taşır.
- NetworkPolicy: Redis'e yalnızca `<sürüm>-redis-client: "true"`, PostgreSQL'e yalnızca
  `bridge.io/postgresql-client: "true"` etiketli pod'lar bağlanır; Bridge pod'u ikisini de taşır.
  Politikaları UYGULAYAN bir CNI (Calico, Cilium, …) gerekir; uygulamayan bir CNI'de nesneler etkisizdir.
- Bağımlılık servis adları Bitnami adlandırmasından türetilir (`<sürüm>-redis-master`, `<sürüm>-postgresql`);
  sürüm adının "bridge" içermesi gerekmez.
