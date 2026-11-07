Pod::Spec.new do |spec|
  spec.name = 'Melodica'
  spec.version = '1.0.0'
  spec.summary = 'Portable melodica.h ABI for Epimetheus.'
  spec.license = { :type => 'MIT', :file => '../../vendor/melodica/LICENSE.libpiano' }
  spec.source = { :path => '.' }
  spec.source_files = 'melodica.c'
  spec.ios.deployment_target = '9.0'
  spec.compiler_flags = '-O3'
end
