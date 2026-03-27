#define MHR_NATIVE_BUILD

#include "mhr_native_api.h"

#include "mhr_runtime.hpp"

namespace {

int wrap_bool(bool value) { return value ? 1 : 0; }

template <typename Callback>
int guard(MhrRuntime* runtime, Callback&& callback) {
  if (runtime == nullptr) {
    return 0;
  }
  return wrap_bool(callback(runtime->impl));
}

template <typename Callback>
int guard_const(const MhrRuntime* runtime, Callback&& callback) {
  if (runtime == nullptr) {
    return 0;
  }
  return wrap_bool(callback(runtime->impl));
}

}  // namespace

const char* mhr_native_version(void) { return "0.1.0"; }

MhrRuntime* mhr_runtime_create(void) { return new MhrRuntime{}; }

void mhr_runtime_destroy(MhrRuntime* runtime) { delete runtime; }

const char* mhr_runtime_last_error(const MhrRuntime* runtime) {
  if (runtime == nullptr) {
    return "Runtime is null.";
  }
  return runtime->impl.last_error().c_str();
}

int mhr_runtime_load_bundle(MhrRuntime* runtime, const MhrBundleView* bundle_view) {
  return guard(runtime, [&](mhr::Runtime& impl) {
    if (bundle_view == nullptr) {
      return false;
    }
    return impl.load_bundle(*bundle_view);
  });
}

int mhr_runtime_reset_state(MhrRuntime* runtime) {
  return guard(runtime, [](mhr::Runtime& impl) { return impl.reset_state(); });
}

int mhr_runtime_set_model_parameters(
    MhrRuntime* runtime,
    const float* values,
    uint32_t count) {
  return guard(runtime, [&](mhr::Runtime& impl) {
    return impl.set_model_parameters(values, count);
  });
}

int mhr_runtime_set_identity(MhrRuntime* runtime, const float* values, uint32_t count) {
  return guard(runtime, [&](mhr::Runtime& impl) { return impl.set_identity(values, count); });
}

int mhr_runtime_set_expression(
    MhrRuntime* runtime,
    const float* values,
    uint32_t count) {
  return guard(runtime, [&](mhr::Runtime& impl) {
    return impl.set_expression(values, count);
  });
}

int mhr_runtime_evaluate(MhrRuntime* runtime) {
  return guard(runtime, [](mhr::Runtime& impl) { return impl.evaluate(); });
}

int mhr_runtime_get_counts(const MhrRuntime* runtime, MhrRuntimeCounts* counts) {
  return guard_const(runtime, [&](const mhr::Runtime& impl) { return impl.get_counts(counts); });
}

int mhr_runtime_get_vertices(
    const MhrRuntime* runtime,
    float* out_values,
    uint32_t count) {
  return guard_const(runtime, [&](const mhr::Runtime& impl) {
    return impl.copy_vertices(out_values, count);
  });
}

int mhr_runtime_get_joint_parameters(
    const MhrRuntime* runtime,
    float* out_values,
    uint32_t count) {
  return guard_const(runtime, [&](const mhr::Runtime& impl) {
    return impl.copy_joint_parameters(out_values, count);
  });
}

int mhr_runtime_get_local_skeleton(
    const MhrRuntime* runtime,
    float* out_values,
    uint32_t count) {
  return guard_const(runtime, [&](const mhr::Runtime& impl) {
    return impl.copy_local_skeleton(out_values, count);
  });
}

int mhr_runtime_get_rest_vertices(
    const MhrRuntime* runtime,
    float* out_values,
    uint32_t count) {
  return guard_const(runtime, [&](const mhr::Runtime& impl) {
    return impl.copy_rest_vertices(out_values, count);
  });
}

int mhr_runtime_get_pose_features(
    const MhrRuntime* runtime,
    float* out_values,
    uint32_t count) {
  return guard_const(runtime, [&](const mhr::Runtime& impl) {
    return impl.copy_pose_features(out_values, count);
  });
}

int mhr_runtime_get_hidden(
    const MhrRuntime* runtime,
    float* out_values,
    uint32_t count) {
  return guard_const(runtime, [&](const mhr::Runtime& impl) {
    return impl.copy_hidden(out_values, count);
  });
}

int mhr_runtime_get_corrective_delta(
    const MhrRuntime* runtime,
    float* out_values,
    uint32_t count) {
  return guard_const(runtime, [&](const mhr::Runtime& impl) {
    return impl.copy_corrective_delta(out_values, count);
  });
}

int mhr_runtime_get_skin_joint_states(
    const MhrRuntime* runtime,
    float* out_values,
    uint32_t count) {
  return guard_const(runtime, [&](const mhr::Runtime& impl) {
    return impl.copy_skin_joint_states(out_values, count);
  });
}

int mhr_runtime_get_skeleton(
    const MhrRuntime* runtime,
    float* out_values,
    uint32_t count) {
  return guard_const(runtime, [&](const mhr::Runtime& impl) {
    return impl.copy_skeleton(out_values, count);
  });
}

int mhr_runtime_get_derived(
    const MhrRuntime* runtime,
    float* out_values,
    uint32_t count) {
  return guard_const(runtime, [&](const mhr::Runtime& impl) {
    return impl.copy_derived(out_values, count);
  });
}
