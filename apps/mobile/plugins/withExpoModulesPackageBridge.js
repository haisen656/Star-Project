const fs = require('fs');
const path = require('path');
const { createRunOncePlugin, withDangerousMod } = require('expo/config-plugins');

const bridgeSource = `package expo.core;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;
import java.util.List;

/**
 * Compatibility bridge for legacy React Native autolinking output.
 * Expo SDK 53 provides the real package in expo.modules.
 */
public final class ExpoModulesPackage implements ReactPackage {
  private final expo.modules.ExpoModulesPackage delegate = new expo.modules.ExpoModulesPackage();

  @Override
  public List<NativeModule> createNativeModules(ReactApplicationContext reactContext) {
    return delegate.createNativeModules(reactContext);
  }

  @Override
  @SuppressWarnings({"rawtypes", "unchecked"})
  public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
    return (List) delegate.createViewManagers(reactContext);
  }
}
`;

function withExpoModulesPackageBridge(config) {
  return withDangerousMod(config, [
    'android',
    async (modConfig) => {
      const javaDirectory = path.join(
        modConfig.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'java',
        'expo',
        'core',
      );

      fs.mkdirSync(javaDirectory, { recursive: true });
      fs.writeFileSync(path.join(javaDirectory, 'ExpoModulesPackage.java'), bridgeSource);
      return modConfig;
    },
  ]);
}

module.exports = createRunOncePlugin(
  withExpoModulesPackageBridge,
  'quickdrop-expo-modules-package-bridge',
  '1.0.0',
);
