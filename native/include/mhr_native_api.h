#ifndef MHR_NATIVE_API_H
#define MHR_NATIVE_API_H

#include <stddef.h>
#include <stdint.h>

#ifdef _WIN32
#  ifdef MHR_NATIVE_BUILD
#    define MHR_NATIVE_EXPORT __declspec(dllexport)
#  else
#    define MHR_NATIVE_EXPORT __declspec(dllimport)
#  endif
#else
#  define MHR_NATIVE_EXPORT
#endif

#ifdef __cplusplus
extern "C" {
#endif

typedef enum MhrScalarType {
  MHR_SCALAR_FLOAT32 = 1,
  MHR_SCALAR_UINT32 = 2,
  MHR_SCALAR_INT32 = 3,
  MHR_SCALAR_INT64 = 4,
  MHR_SCALAR_UINT8 = 5
} MhrScalarType;

typedef struct MhrArrayView {
  const char* key;
  const void* data;
  size_t byte_length;
  MhrScalarType scalar_type;
  uint32_t rank;
  const uint64_t* shape;
} MhrArrayView;

typedef struct MhrBundleView {
  uint32_t version;
  uint32_t array_count;
  const MhrArrayView* arrays;
} MhrBundleView;

typedef struct MhrRuntimeCounts {
  uint32_t model_parameter_count;
  uint32_t identity_count;
  uint32_t expression_count;
  uint32_t vertex_count;
  uint32_t joint_count;
} MhrRuntimeCounts;

typedef struct MhrRuntimeDebugTiming {
  float reset_state_ms;
  float parameter_upload_ms;
  float evaluate_core_ms;
  float vertices_export_ms;
  float skeleton_export_ms;
  float derived_export_ms;
  float parameter_decode_ms;
  float joint_world_transforms_ms;
  float surface_morph_ms;
  float pose_features_ms;
  float corrective_stage1_ms;
  float corrective_stage2_ms;
  float skinning_ms;
  float derived_stage_ms;
} MhrRuntimeDebugTiming;

typedef struct MhrRuntime MhrRuntime;

MHR_NATIVE_EXPORT const char* mhr_native_version(void);

MHR_NATIVE_EXPORT MhrRuntime* mhr_runtime_create(void);
MHR_NATIVE_EXPORT void mhr_runtime_destroy(MhrRuntime* runtime);
MHR_NATIVE_EXPORT const char* mhr_runtime_last_error(const MhrRuntime* runtime);

MHR_NATIVE_EXPORT int mhr_runtime_load_bundle(MhrRuntime* runtime, const MhrBundleView* bundle_view);
MHR_NATIVE_EXPORT int mhr_runtime_reset_state(MhrRuntime* runtime);
MHR_NATIVE_EXPORT int mhr_runtime_set_model_parameters(
  MhrRuntime* runtime,
  const float* values,
  uint32_t count
);
MHR_NATIVE_EXPORT int mhr_runtime_set_identity(
  MhrRuntime* runtime,
  const float* values,
  uint32_t count
);
MHR_NATIVE_EXPORT int mhr_runtime_set_expression(
  MhrRuntime* runtime,
  const float* values,
  uint32_t count
);
MHR_NATIVE_EXPORT int mhr_runtime_evaluate(MhrRuntime* runtime);
MHR_NATIVE_EXPORT int mhr_runtime_get_counts(const MhrRuntime* runtime, MhrRuntimeCounts* counts);
MHR_NATIVE_EXPORT int mhr_runtime_get_debug_timing(
  const MhrRuntime* runtime,
  MhrRuntimeDebugTiming* timing
);
MHR_NATIVE_EXPORT int mhr_runtime_get_vertices(
  const MhrRuntime* runtime,
  float* out_values,
  uint32_t count
);
MHR_NATIVE_EXPORT int mhr_runtime_get_joint_parameters(
  const MhrRuntime* runtime,
  float* out_values,
  uint32_t count
);
MHR_NATIVE_EXPORT int mhr_runtime_get_local_skeleton(
  const MhrRuntime* runtime,
  float* out_values,
  uint32_t count
);
MHR_NATIVE_EXPORT int mhr_runtime_get_rest_vertices(
  const MhrRuntime* runtime,
  float* out_values,
  uint32_t count
);
MHR_NATIVE_EXPORT int mhr_runtime_get_pose_features(
  const MhrRuntime* runtime,
  float* out_values,
  uint32_t count
);
MHR_NATIVE_EXPORT int mhr_runtime_get_hidden(
  const MhrRuntime* runtime,
  float* out_values,
  uint32_t count
);
MHR_NATIVE_EXPORT int mhr_runtime_get_corrective_delta(
  const MhrRuntime* runtime,
  float* out_values,
  uint32_t count
);
MHR_NATIVE_EXPORT int mhr_runtime_get_skin_joint_states(
  const MhrRuntime* runtime,
  float* out_values,
  uint32_t count
);
MHR_NATIVE_EXPORT int mhr_runtime_get_skeleton(
  const MhrRuntime* runtime,
  float* out_values,
  uint32_t count
);
MHR_NATIVE_EXPORT int mhr_runtime_get_derived(
  const MhrRuntime* runtime,
  float* out_values,
  uint32_t count
);

#ifdef __cplusplus
}
#endif

#endif
