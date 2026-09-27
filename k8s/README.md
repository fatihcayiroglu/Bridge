# Bridge — Kubernetes Deployment

## Gereksinimler

- Kubernetes 1.28+
- kubectl
- (Opsiyonel) Helm, nginx ingress controller, cert-manager, metrics-server

## Hızlı Kurulum

```bash
# 1. Secret'ları Sealed Secrets ile üret (düz Secret'ı git'e commit ETME!)
#    Şablon ve kubeseal komutları: k8s/sealed-secret.yaml başlığındaki notlar.
#    Kısaca:
#      kubectl -n bridge create secret generic bridge-secrets #        --from-literal=JWT_SECRET=... --dry-run=client -o yaml #      | kubeseal --format yaml > k8s/sealed-secret.yaml

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
| `sealed-secret.yaml` | Sealed Secrets ile şifrelenmiş gizli değerler (Sprint 85) |
| `postgres.yaml` | PostgreSQL StatefulSet + headless Service |
| `redis.yaml` | Redis Deployment + Service — parola ZORUNLU (`bridge-secrets/REDIS_PASSWORD`), `REDIS_URL` parolayı taşır |
| `networkpolicy.yaml` | Redis (6379) ve PostgreSQL (5432) yalnızca `app: bridge` pod'larından; NetworkPolicy uygulayan bir CNI gerekir |
| `bridge.yaml` | Bridge app Deployment (replicas:2) + Service |
| `ingress.yaml` | nginx Ingress (WebSocket desteğiyle) |
| `hpa.yaml` | CPU/Memory bazlı otomatik ölçekleme (2–10 replica) |
| `pdb.yaml` | Min 1 pod her zaman ayakta |
| `servicemonitor.yaml` | Prometheus ServiceMonitor |

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
