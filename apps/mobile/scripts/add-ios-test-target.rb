# One-time project generation helper. The resulting target and scheme are committed.
require 'xcodeproj'

project_path = File.expand_path('../ios/BridgeNative.xcodeproj', __dir__)
project = Xcodeproj::Project.open(project_path)
abort 'UI test target already exists' if project.targets.any? { |target| target.name == 'BridgeNativeUITests' }
app = project.targets.find { |target| target.name == 'BridgeNative' }
abort 'Missing preview application target' unless app
target = project.new_target(:ui_test_bundle, 'BridgeNativeUITests', :ios, '15.1')
target.add_dependency(app)
group = project.main_group.new_group('BridgeNativeUITests', 'BridgeNativeUITests')
file = group.new_file('ServerConnectionJourneyTests.swift')
target.source_build_phase.add_file_reference(file)
target.build_configurations.each do |config|
  config.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER' => 'com.bridge.nativepreview.uitests',
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'SWIFT_VERSION' => '5.0',
    'TEST_TARGET_NAME' => app.name,
    'TARGETED_DEVICE_FAMILY' => '1,2'
  })
end
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(app)
scheme.add_build_target(target, false)
scheme.add_test_target(target)
scheme.set_launch_target(app)
scheme.save_as(project_path, 'BridgeNative', true)
