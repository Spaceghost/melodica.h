#!/usr/bin/env python

import setuptools


setuptools.setup(
    packages=setuptools.find_packages() + ["melodica"],
    package_dir={
        "melodica": "vendor/melodica.h/bindings/python/melodica",
    },
)
