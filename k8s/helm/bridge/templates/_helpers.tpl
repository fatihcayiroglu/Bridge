{{/*
  k8s/helm/bridge/templates/_helpers.tpl
  Paylaşılan template yardımcıları
*/}}

{{- define "bridge.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "bridge.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "bridge.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "bridge.labels" -}}
helm.sh/chart: {{ include "bridge.chart" . }}
{{ include "bridge.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
  Final21 Faz 19 — BAĞIMLILIK SERVİS ADLARI.
  Bitnami alt çizelgeleri servislerini KENDİ tam adlarıyla adlandırır: sürüm adı çizelge adını
  içeriyorsa sürüm adı, değilse `<sürüm>-<çizelge>` (common.names.fullname). Eskiden
  `bridge.fullname` + sonek kullanılıyordu: yalnızca adı "bridge" içeren bir sürümde doğru
  sonuç veriyordu; `helm install prod …` uygulamayı OLMAYAN `prod-bridge-redis-master` ve
  `prod-bridge-postgresql` adreslerine yönlendiriyordu.
*/}}
{{- define "bridge.dependencyFullname" -}}
{{- $root := index . 0 -}}
{{- $chart := index . 1 -}}
{{- $values := index $root.Values $chart | default dict -}}
{{- if $values.fullnameOverride -}}
{{- $values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if contains $chart $root.Release.Name -}}
{{- $root.Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" $root.Release.Name $chart | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end }}

{{- define "bridge.selectorLabels" -}}
app.kubernetes.io/name: {{ include "bridge.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
  Final21 Faz 10 — F21-10-02: ÇOK REPLİKADA YÜKLEMELER POD'A YEREL OLAMAZ.

  Varsayılan yükleme deposu yerel disktir (`CDN_PROVIDER` ve
  `PRIVATE_STORAGE_PROVIDER` ayrı ayrı `local`a düşer) ve `uploads` birimi
  `emptyDir`dir. İki gerçek Bridge örneği (aynı PostgreSQL + Redis, pod başına
  ayrı yükleme kökü) önünde ÖLÇÜLDÜ:

      pod-A üzerinden avatar yüklendi -> GET pod-A 200, GET pod-B 404
      pod-B /api/me aynı URL'yi kullanıcıya VERİYOR (paylaşılan veritabanı)

  Yani döngüsel yük dengelemede görsellerin yaklaşık yarısı 404 döner ve pod
  yeniden başlayınca TÜM yüklemeler kaybolur. `persistence.enabled` +
  ReadWriteOnce de çözmez: farklı düğümlerdeki podlar aynı birimi bağlayamaz.

  Bu şablon, veri kaybeden yapılandırmanın SESSİZCE kurulmasını engeller.
  Kabul edilen üç yol:
    1. Uzak depolama: `CDN_PROVIDER` VE `PRIVATE_STORAGE_PROVIDER` (s3/r2/minio/b2)
       `env` ya da `secrets` içinde ayarlı. İkisi de gerekir: özel ekler, genel
       CDN uzak olsa bile ayrıca yerel diske düşer.
    2. Paylaşılan birim: `persistence.enabled: true` ve `accessMode: ReadWriteMany`.
    3. Tek replika: `replicaCount: 1` ve `autoscaling.enabled: false`.
*/}}
{{- define "bridge.validateUploadStorage" -}}
{{- $multi := or (gt (int .Values.replicaCount) 1) .Values.autoscaling.enabled -}}
{{- $env := .Values.env | default dict -}}
{{- $sec := .Values.secrets | default dict -}}
{{- $public := lower (toString (default (index $sec "CDN_PROVIDER") (index $env "CDN_PROVIDER"))) -}}
{{- $private := lower (toString (default (index $sec "PRIVATE_STORAGE_PROVIDER") (index $env "PRIVATE_STORAGE_PROVIDER"))) -}}
{{- $remote := list "s3" "r2" "minio" "b2" -}}
{{- $remoteStorage := and (has $public $remote) (has $private $remote) -}}
{{- $sharedVolume := and .Values.persistence.enabled (eq (toString .Values.persistence.accessMode) "ReadWriteMany") -}}
{{- if and $multi (not (or $remoteStorage $sharedVolume)) -}}
{{- fail "bridge: multi-replica deployment with node-local uploads loses files (measured: upload via pod A -> 404 via pod B). Set env.CDN_PROVIDER and env.PRIVATE_STORAGE_PROVIDER to s3|r2|minio|b2, or persistence.enabled=true with persistence.accessMode=ReadWriteMany, or replicaCount=1 with autoscaling.enabled=false." -}}
{{- end -}}
{{- end }}
