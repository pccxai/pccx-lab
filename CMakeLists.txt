cmake_minimum_required(VERSION 3.20)
project(pccx-lab VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(CTest)
enable_testing()

add_subdirectory(src/core)
add_subdirectory(src/ui)

add_subdirectory(src/uvm_bridge)
