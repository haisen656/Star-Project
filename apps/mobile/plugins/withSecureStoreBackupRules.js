const fs = require('fs');
const path = require('path');
const { createRunOncePlugin, withDangerousMod } = require('expo/config-plugins');

const backupRules = `<?xml version="1.0" encoding="utf-8"?>
<full-backup-content>
  <include domain="sharedpref" path="." />
  <exclude domain="sharedpref" path="SecureStore" />
</full-backup-content>
`;

const extractionRules = `<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
  <cloud-backup disableIfNoEncryptionCapabilities="true">
    <include domain="sharedpref" path="." />
    <exclude domain="sharedpref" path="SecureStore" />
  </cloud-backup>
  <device-transfer>
    <include domain="sharedpref" path="." />
    <exclude domain="sharedpref" path="SecureStore" />
  </device-transfer>
</data-extraction-rules>
`;

function withSecureStoreBackupRules(config) {
  return withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const xmlDirectory = path.join(
        modConfig.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml',
      );

      fs.mkdirSync(xmlDirectory, { recursive: true });
      fs.writeFileSync(path.join(xmlDirectory, 'secure_store_backup_rules.xml'), backupRules);
      fs.writeFileSync(path.join(xmlDirectory, 'secure_store_data_extraction_rules.xml'), extractionRules);
      return modConfig;
    },
  ]);
}

module.exports = createRunOncePlugin(
  withSecureStoreBackupRules,
  'quickdrop-secure-store-backup-rules',
  '1.0.0',
);
