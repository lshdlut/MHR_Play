#ifndef MHR_RUNTIME_HPP
#define MHR_RUNTIME_HPP

#include <stdint.h>

#include <string>
#include <unordered_map>
#include <vector>

#include "mhr_native_api.h"

namespace mhr {

struct BundleArray final {
  MhrScalarType scalar_type = MHR_SCALAR_FLOAT32;
  std::vector<uint64_t> shape;
  const void* data = nullptr;
  size_t byte_length = 0;
};

struct BundleData final {
  std::unordered_map<std::string, BundleArray> arrays;
  uint32_t model_parameter_count = 0;
  uint32_t identity_count = 0;
  uint32_t expression_count = 0;
  uint32_t vertex_count = 0;
  uint32_t joint_count = 0;
  uint32_t max_influence_count = 0;
};

class Runtime final {
 public:
  Runtime() = default;

  const std::string& last_error() const noexcept { return last_error_; }

  bool load_bundle(const MhrBundleView& bundle_view);
  bool reset_state();
  bool set_model_parameters(const float* values, uint32_t count);
  bool set_identity(const float* values, uint32_t count);
  bool set_expression(const float* values, uint32_t count);
  bool evaluate();

  bool get_counts(MhrRuntimeCounts* counts) const;
  bool get_debug_timing(MhrRuntimeDebugTiming* timing) const;
  bool copy_joint_parameters(float* out_values, uint32_t count) const;
  bool copy_local_skeleton(float* out_values, uint32_t count) const;
  bool copy_rest_vertices(float* out_values, uint32_t count) const;
  bool copy_pose_features(float* out_values, uint32_t count) const;
  bool copy_hidden(float* out_values, uint32_t count) const;
  bool copy_corrective_delta(float* out_values, uint32_t count) const;
  bool copy_skin_joint_states(float* out_values, uint32_t count) const;
  bool copy_vertices(float* out_values, uint32_t count) const;
  bool copy_skeleton(float* out_values, uint32_t count) const;
  bool copy_derived(float* out_values, uint32_t count) const;

 private:
  bool require_bundle_loaded() const;
  bool set_error(const std::string& message);

  bool validate_bundle(const MhrBundleView& bundle_view);
  bool load_array(const MhrArrayView& view);

  BundleData bundle_;
  std::vector<float> model_parameters_;
  std::vector<float> identity_;
  std::vector<float> expression_;

  std::vector<float> joint_parameters_;
  std::vector<float> local_skeleton_;
  std::vector<float> skeleton_;
  std::vector<float> rest_vertices_;
  std::vector<float> pose_features_;
  std::vector<float> hidden_;
  std::vector<float> corrective_delta_;
  std::vector<float> skin_joint_states_;
  std::vector<float> vertices_;
  std::vector<float> derived_;
  mutable MhrRuntimeDebugTiming debug_timing_{};

  bool bundle_loaded_ = false;
  bool evaluated_ = false;
  std::string last_error_;
};

}  // namespace mhr

struct MhrRuntime {
  mhr::Runtime impl;
};

#endif
