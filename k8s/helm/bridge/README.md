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

# Kurulum (development)
helm install bridge ./k8s/helm/bridge \
  --namespace bridge \
  --set secrets.JWT_SECRET="$(openssl rand -hex 32)" \
  --set secrets.REFRESH_SECRET="$(openssl rand -hex 32)"

# Kurulum (production — values dosyasıyla)
helm install bridge ./k8s/helm/bridge \
  --namespace bridge \
  -f k8s/helm/bridge/values-production.yaml
```

## Üretim values-production.yaml Örneği

```yaml
image:
  repository: ghcr.io/your-org/bridge
  tag: "1.117.0"

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
  enabled: false  # Harici managed Redis kullan

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
