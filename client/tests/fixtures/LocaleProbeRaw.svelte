<script lang="ts">
  // KONTROL SONDASI — kasıtlı olarak HAM (reaktif olmayan) t() kullanır.
  // Kusurun gerçekten var olduğunu gösterir; düzeltmenin neyi çözdüğünü
  // kanıtlayan karşı örnektir. Ürün kodu bu yolu KULLANMAMALIDIR.
  import { t } from '../../js/core/i18n/index.ts';
</script>

<span data-testid="probe-raw">{t('sign_in', 'Giriş yap')}</span>
