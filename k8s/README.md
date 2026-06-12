# Bridge — Kubernetes Deployment

## Gereksinimler

- Kubernetes 1.28+
- kubectl
- (Opsiyonel) Helm, nginx ingress controller, cert-manager, metrics-server

## Hızlı Kurulum

```bash
# 1. Secret değerlerini doldur (git'e commit ETME!)
cp secret.yaml secret.local.yaml
# secret.local.yaml içindeki base64 değerlerini doldur:
#   echo -n "uzun_rastgele_jwt_secret" | base64

# 2. Tüm kaynakları uygula
kubectl apply -k k8s/

# 3. Durumu kontrol et
kubectl get all -n bridge

# 4. Pod loglarını izle
kubectl logs -f deploy/bridge -n bridge
```

## Bileşenler

| Dosya | Açıklama |
|---|---|
| `namespace.yaml` | `bridge` namespace |
| `configmap.yaml` | Ortam değişkenleri (gizli olmayan) |
| `secret.yaml` | Gizli değerler şablonu — doldurulması gerekir |
| `postgres.yaml` | PostgreSQL StatefulSet + headless Service |
| `redis.yaml` | Redis Deployment + Service |
| `bridge.yaml` | Bridge app Deployment (replicas:2) + Service |
| `ingress.yaml` | nginx Ingress (WebSocket desteğiyle) |
| `hpa.yaml` | CPU/Memory bazlı otomatik ölçekleme (2–10 replica) |
| `pdb.yaml` | Min 1 pod her zaman ayakta |

## Domain Yapılandırması

`ingress.yaml` içinde `bridge.senindomain.com` yerine kendi domain'ini yaz.

## TLS (HTTPS)

cert-manager kuruluysa `ingress.yaml` içindeki TLS bloğunu ve
`cert-manager.io/cluster-issuer` annotation'ını uncomment et.

## Güncelleme

```bash
# Yeni image build et
docker build -t bridge-app:v1.83.0 .

# Deployment güncelle
kubectl set image deployment/bridge bridge=bridge-app:v1.83.0 -n bridge

# Rollout durumu
kubectl rollout status deployment/bridge -n bridge
```

## Geri Alma

```bash
kubectl rollout undo deployment/bridge -n bridge
```
