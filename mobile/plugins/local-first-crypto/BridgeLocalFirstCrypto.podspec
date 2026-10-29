require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'BridgeLocalFirstCrypto'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/fatihcayiroglu/Bridge'
  s.author = 'Bridge contributors'
  s.source = { :git => 'https://github.com/fatihcayiroglu/Bridge.git' }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.frameworks = 'Security', 'CryptoKit'
  s.swift_version = '5.1'
end
