#include <node.h>
#include <node_buffer.h>
#include <nan.h>
#include <unordered_map>
#include <unordered_set>
#ifdef _MSC_VER
# include <malloc.h>
#endif

#include <sqlite3mc_amalgamation.h>

using namespace node;
using namespace v8;
using namespace std;

#include "status_codes.h"

enum QueryFlag : uint32_t {
  SingleStatement = 0x01,
  NamedParams = 0x02,
  RowsAsArray = 0x04,
};

enum StatementStatus : uint8_t {
  Init = 0x00,
  Complete = 0x01,
  Incomplete = 0x02,
  Error = 0x03,
  Done = 0x04,
};

enum class BindParamsType : uint8_t {
  None,
  Numeric,
  Named
};

enum class ValueType : uint8_t {
  Null,
  StringEmpty,
  String,
  BlobEmpty,
  Blob,
  Int32Internal,
  Int64,
  Int64Internal,
  Int64Internal4,
  Double,
  DoubleInternal
}; 

typedef struct {
  ValueType type;
  void* val;
} BindValue;

typedef unordered_map<string, BindValue> NamedParamsMap;

typedef struct { 
  ValueType type;
  int len;
  void* val;
} RowValue;

void free_blob(char* data, void* hint) {
  free(data);
}

class BindValueBlob {
  public:
    BindValueBlob(Local<Value>& buf_) {
      ref.Reset(buf_);
      data = Buffer::Data(buf_);
      len = Buffer::Length(buf_);
    }
    ~BindValueBlob() {
      ref.Reset();
    }

    Nan::Persistent<Value> ref;
    char* data;
    size_t len;
};

// When creating strings >= this length V8's GC spins up and consumes
// most of the execution time. For these cases it's more performant to
// use external string resources.
// This value comes from node.js core.
#define EXTERN_APEX 0xFBEE9
class ExtString : public String::ExternalOneByteStringResource {
 public:
  explicit ExtString(char* data, size_t len) : data_(data), len_(len) {
    Nan::AdjustExternalMemory(len);
  }
  ~ExtString() override {
    if (data_) {
      free(data_);
      Nan::AdjustExternalMemory(-len_);
    }
  }
  const char* data() const override { return data_; }
  size_t length() const override { return len_; }

  char* data_;
  size_t len_;
};

typedef int (*SqliteAuthCallback)(void*,int,const char*,const char*,const char*,
                                  const char*);

bool bind_value(sqlite3_stmt* stmt, int index, BindValue& bv, int* res) {
  switch (bv.type) {
    case ValueType::Null:
      *res = sqlite3_bind_null(stmt, index);
      break;
    case ValueType::Int32Internal: {
      int32_t intval;
      memcpy(&intval, &bv.val, 4);
      *res = sqlite3_bind_int(stmt, index, intval);
      break;
    }
    case ValueType::Int64: {
      *res = sqlite3_bind_int64(stmt, index, *(static_cast<int64_t*>(bv.val)));
      break;
    }
    case ValueType::Int64Internal: {
      int64_t int64val;
      memcpy(&int64val, &bv.val, 8);
      *res = sqlite3_bind_int64(stmt, index, int64val);
      break;
    }
    case ValueType::Int64Internal4: {
      uint32_t uintval;
      memcpy(&uintval, &bv.val, 4);
      *res = sqlite3_bind_int64(stmt, index, uintval);
      break;
    }
    case ValueType::StringEmpty:
      // XXX: hack to get an actual empty string instead of a NULL value
      *res = sqlite3_bind_text(stmt,
                               index,
                               reinterpret_cast<const char*>(1),
                               0,
                               SQLITE_STATIC);
      break;
    case ValueType::String: {
      Nan::Utf8String* str = static_cast<Nan::Utf8String*>(bv.val);
      *res =
        sqlite3_bind_text(stmt, index, **str, str->length(), SQLITE_STATIC);
      break;
    }
    case ValueType::BlobEmpty:
      // XXX: hack to get an actual empty blob instead of a NULL value
      *res = sqlite3_bind_blob(stmt,
                               index,
                               reinterpret_cast<const void*>(1),
                               0,
                               SQLITE_STATIC);
      break;
    case ValueType::Blob: {
      BindValueBlob* blob = static_cast<BindValueBlob*>(bv.val);
      *res = sqlite3_bind_blob64(stmt,
                                 index,
                                 blob->data,
                                 blob->len,
                                 SQLITE_STATIC);
      break;
    }
    case ValueType::Double:
      *res = sqlite3_bind_double(stmt, index, *(static_cast<double*>(bv.val)));
      break;
    case ValueType::DoubleInternal: {
      double doubleval;
      memcpy(&doubleval, &bv.val, 8);
      *res = sqlite3_bind_double(stmt, index, doubleval);
      break;
    }
    default:
      return false;
  }
  return true;
}

void bind_value_cleanup(BindValue& bv) {
  switch (bv.type) {
    case ValueType::String: {
      Nan::Utf8String* str = static_cast<Nan::Utf8String*>(bv.val);
      delete str;
      break;
    }
    case ValueType::Blob: {
      BindValueBlob* blob = static_cast<BindValueBlob*>(bv.val);
      delete blob;
      break;
    }
    case ValueType::Double: {
      double* doubleval = static_cast<double*>(bv.val);
      delete doubleval;
      break;
    }
    case ValueType::Int64: {
      int64_t* int64val = static_cast<int64_t*>(bv.val);
      delete int64val;
      break;
    }
    default:
      return;
  }
  bv.val = nullptr;
}

bool set_bind_value(BindValue& bv, Local<Value>& val) {
  if (val->IsNullOrUndefined()) {
    bv.type = ValueType::Null;
  } else if (val->IsInt32()) {
    int32_t intval = Nan::To<int32_t>(val).FromJust();
    bv.type = ValueType::Int32Internal;
    memcpy(&bv.val, &intval, 4);
  } else if (val->IsUint32() || val->IsBoolean()) {
    uint32_t uintval = Nan::To<uint32_t>(val).FromJust();
    memcpy(&bv.val, &uintval, 4);
    if (uintval <= 2147483647)
      bv.type = ValueType::Int32Internal;
    else
      bv.type = ValueType::Int64Internal4;
  } else if (val->IsString()) {
    Local<String> str = Local<String>::Cast(val);
    if (str->Length() == 0) {
      bv.type = ValueType::StringEmpty;
    } else {
      bv.type = ValueType::String;
      bv.val = new Nan::Utf8String(val);
    }
  } else if (val->IsNumber()) {
    double doubleval = Nan::To<double>(val).FromJust();
    if (sizeof(void*) == 4) {
      bv.type = ValueType::Double;
      double* val_ptr = new double;
      *val_ptr = doubleval;
      bv.val = val_ptr;
    } else {
      bv.type = ValueType::DoubleInternal;
      memcpy(&bv.val, &doubleval, 8);
    }
  } else if (val->IsBigInt()) {
    Local<BigInt> bi = val->ToBigInt(Nan::GetCurrentContext()).ToLocalChecked();
    bool lossless;
    int64_t int64val = bi->Int64Value(&lossless);
    if (!lossless)
      return false; // Value too large for SQLite's API
    if (int64val >= -2147483648 && int64val <= 2147483647) {
      int32_t intval = int64val;
      bv.type = ValueType::Int32Internal;
      memcpy(&bv.val, &intval, 4);
    } else if (sizeof(void*) == 4) {
      bv.type = ValueType::Int64;
      int64_t* val_ptr = new int64_t;
      *val_ptr = int64val;
      bv.val = val_ptr;
    } else {
      bv.type = ValueType::Int64Internal;
      memcpy(&bv.val, &int64val, 8);
    }
  } else if (Buffer::HasInstance(val)) {
    // Assume Blob
    if (Buffer::Length(val) == 0) {
      bv.type = ValueType::BlobEmpty;
    } else {
      bv.type = ValueType::Blob;
      bv.val = new BindValueBlob(val);
    }
  } else {
    return false;
  }
  return true;
}

class AuthorizerRequest;
class QueryRequest;

class DBHandle : public Nan::ObjectWrap {
 public:
  explicit DBHandle(Local<Function> make_rows_fn_,
                    Local<Function> make_obj_row_fn_,
                    Local<Function> make_arr_row_fn_,
                    Local<Function> status_callback_);
  ~DBHandle();

  static NAN_METHOD(New);
  static NAN_METHOD(Open);
  static NAN_METHOD(Query);
  static NAN_METHOD(AutoCommit);
  static NAN_METHOD(Limit);
  static NAN_METHOD(Interrupt);
  static NAN_METHOD(Close);
  static NAN_METHOD(Abort);
  static inline Eternal<Function> & constructor() {
    static Eternal<Function> my_constructor;
    return my_constructor;
  }

  sqlite3* db_;
  size_t working_;
  QueryRequest* cur_req;
  Nan::Persistent<Function> make_rows_fn;
  Nan::Persistent<Function> make_obj_row_fn;
  Nan::Persistent<Function> make_arr_row_fn;
  AuthorizerRequest* authorizeReq;
  Nan::Persistent<Function> status_callback;
};

class AuthorizerRequest : public Nan::AsyncResource {
public:
  AuthorizerRequest(SqliteAuthCallback cb)
    : Nan::AsyncResource("esqlite:AuthorizerRequestNoJSCB") {
    async.data = nullptr;
    sqlite_auth_callback = cb;
  }
  AuthorizerRequest(SqliteAuthCallback cb, Local<Function> js_cb)
    : Nan::AsyncResource("esqlite:AuthorizerRequestJSCB"), match_result(-1) {
    int status = uv_mutex_init(&mutex);
    assert(status == 0);

    status = uv_cond_init(&cond);
    assert(status == 0);

    status = uv_async_init(
      Nan::GetCurrentEventLoop(),
      &async,
      AuthorizerRequest::authorize_async_cb
    );
    assert(status == 0);
    async.data = this;
    // Don't let this keep the event loop alive
    uv_unref(reinterpret_cast<uv_handle_t*>(&async));

    js_callback.Reset(js_cb);
    sqlite_auth_callback = cb;
  }
  ~AuthorizerRequest() {
    if (!js_callback.IsEmpty()) {
      uv_mutex_destroy(&mutex);
      uv_cond_destroy(&cond);
      js_callback.Reset();
    }
  }

  static void uv_close_callback(uv_handle_t* handle) {
    AuthorizerRequest* req = static_cast<AuthorizerRequest*>(handle->data);
    delete req;
  }

  static void authorize_async_cb(uv_async_t* handle) {
    Nan::HandleScope scope;
    AuthorizerRequest* req = static_cast<AuthorizerRequest*>(handle->data);
    uv_mutex_lock(&req->mutex);

    Local<Value> argv[5];
    argv[0] = Nan::New<Int32>(req->code);
    if (req->arg1 == nullptr)
      argv[1] = Nan::Null();
    else
      argv[1] = Nan::New<String>(req->arg1).ToLocalChecked();
    if (req->arg2 == nullptr)
      argv[2] = Nan::Null();
    else
      argv[2] = Nan::New<String>(req->arg2).ToLocalChecked();
    if (req->arg3 == nullptr)
      argv[3] = Nan::Null();
    else
      argv[3] = Nan::New<String>(req->arg3).ToLocalChecked();
    if (req->arg4 == nullptr)
      argv[4] = Nan::Null();
    else
      argv[4] = Nan::New<String>(req->arg4).ToLocalChecked();

    Local<Value> ret = req->runInAsyncScope(
      Nan::GetCurrentContext()->Global(),
      Nan::New(req->js_callback),
      5,
      argv
    ).ToLocalChecked();

    if (ret->IsTrue())
      req->result = SQLITE_OK;
    else if (ret->IsFalse())
      req->result = SQLITE_DENY;
    else
      req->result = SQLITE_IGNORE;

    uv_cond_signal(&req->cond);
    uv_mutex_unlock(&req->mutex);
  }

  void close() {
    if (async.data != nullptr) {
      uv_handle_t* handle = reinterpret_cast<uv_handle_t*>(&async);
      if (uv_is_active(handle) && !uv_is_closing(handle))
        uv_close(handle, uv_close_callback);
    } else {
      delete this;
    }
  }

  SqliteAuthCallback sqlite_auth_callback;
  Nan::Persistent<Function> js_callback;
  uv_async_t async;
  uv_mutex_t mutex;
  uv_cond_t cond;
  unordered_set<int> filter;
  int match_result;
  int nomatch_result;

  int code;
  const char* arg1;
  const char* arg2;
  const char* arg3;
  const char* arg4;
  int result;
};

class QueryRequest : public Nan::AsyncResource {
public:
  QueryRequest(Local<Object> handle_,
               DBHandle* handle_ptr_,
               Local<Value> sql_str_,
               BindParamsType params_type_,
               void* params_,
               unsigned int prepare_flags_,
               uint32_t query_flags_,
               size_t initial_max_rows_)
    : Nan::AsyncResource("esqlite:QueryRequest"),
      handle_ptr(handle_ptr_),
      active(false),
      sql_utf8str(sql_str_),
      sql_pos(0),
      params_type(params_type_),
      params(params_),
      bind_list_pos(0),
      prepare_flags(prepare_flags_),
      query_flags(query_flags_),
      cur_stmt(nullptr),
      max_rows(initial_max_rows_),
      col_count(0),
      last_status(StatementStatus::Init),
      sqlite_status(0),
      last_error(nullptr),
      defer_delete(false) {
    sql_remaining = sql_utf8str.length();
    sql_str.Reset(sql_str_);
    handle.Reset(handle_);
    cur_stmt_rowfn.Reset();
    request.data = this;
  }

  ~QueryRequest() {
    handle.Reset();
    sql_str.Reset();
    switch (params_type) {
      case BindParamsType::Named: {
        NamedParamsMap* map = static_cast<NamedParamsMap*>(params);
        NamedParamsMap::iterator it = map->begin();
        while (it != map->end()) {
          bind_value_cleanup(it->second);
          ++it;
        }
        delete map;
        break;
      }
      case BindParamsType::Numeric: {
        vector<BindValue>* list =
          static_cast<vector<BindValue>*>(params);
        for (size_t i = 0; i < list->size(); ++i)
          bind_value_cleanup(list->at(i));
        delete list;
        break;
      }
      default:
        // Appease compiler
        break;
    }
    cur_stmt_rowfn.Reset();
    if (last_error)
      free(last_error);
  }

  uv_work_t request;

  Nan::Persistent<Object> handle;
  DBHandle* handle_ptr;
  bool active;

  Nan::Persistent<Value> sql_str;
  Nan::Utf8String sql_utf8str;
  size_t sql_remaining;
  size_t sql_pos;

  BindParamsType params_type;
  void* params;
  size_t bind_list_pos;

  unsigned int prepare_flags;
  uint32_t query_flags;

  sqlite3_stmt* cur_stmt;
  Nan::Persistent<Function> cur_stmt_rowfn;
  size_t max_rows;
  int col_count;
  StatementStatus last_status;
  int sqlite_status;
  vector<vector<RowValue>> rows;
  char* last_error;
  bool defer_delete;
};

void QueryWork(uv_work_t* req) {
  QueryRequest* query_req = static_cast<QueryRequest*>(req->data);

  bool is_new = (query_req->cur_stmt == nullptr);
  int res;
  if (is_new) {
    for (;;) {
      const char* new_pos;
      const char* cur_pos = (*(query_req->sql_utf8str)) + query_req->sql_pos;
      res = sqlite3_prepare_v3(query_req->handle_ptr->db_,
                               cur_pos,
                               query_req->sql_remaining,
                               query_req->prepare_flags,
                               &query_req->cur_stmt,
                               &new_pos);
      size_t consumed = (new_pos - cur_pos);
      query_req->sql_pos += consumed;
      query_req->sql_remaining -= consumed;
      query_req->col_count = sqlite3_column_count(query_req->cur_stmt);
      if (res != SQLITE_OK) {
        query_req->last_status = StatementStatus::Error;
        query_req->last_error =
          strdup(sqlite3_errmsg(query_req->handle_ptr->db_));
        query_req->sqlite_status = res;
        sqlite3_finalize(query_req->cur_stmt);
        query_req->cur_stmt = nullptr;
        if (!consumed) {
          // Fatal syntax error or similar, no way to continue for this query
          query_req->sql_pos += query_req->sql_remaining;
          query_req->sql_remaining = 0;
        }
        return;
      } else if (!query_req->cur_stmt) {
        // We can get here if the SQL string was just whitespace or a comment
        // for example

        if (!query_req->sql_remaining) {
          query_req->last_status = StatementStatus::Done;
          return;
        }
      } else {
        break;
      }
    }

    // Bind any parameters
    int nbinds = sqlite3_bind_parameter_count(query_req->cur_stmt);
    if (nbinds > 0) {
      switch (query_req->params_type) {
        case BindParamsType::Named: {
          NamedParamsMap* map =
            static_cast<NamedParamsMap*>(query_req->params);
          for (int index = 1; index <= nbinds; ++index) {
            const char* name =
              sqlite3_bind_parameter_name(query_req->cur_stmt, index);
            if (name == nullptr)
              continue;

            // TODO: switch to map keyed on C string instead to avoid copying
            //       of parameter name?
            auto it = map->find(string(name));

            if (it == map->end())
              continue;

            if (!bind_value(query_req->cur_stmt, index, it->second, &res)) {
              query_req->last_status = StatementStatus::Error;
              query_req->last_error = strdup("Invalid bind param type");
              query_req->sqlite_status = -1;
              sqlite3_finalize(query_req->cur_stmt);
              query_req->cur_stmt = nullptr;
              return;
            }
            if (res != SQLITE_OK) {
              query_req->last_status = StatementStatus::Error;
              query_req->last_error =
                strdup(sqlite3_errmsg(query_req->handle_ptr->db_));
              query_req->sqlite_status = -1;
              sqlite3_finalize(query_req->cur_stmt);
              query_req->cur_stmt = nullptr;
              return;
            }
          }
          break;
        }
        case BindParamsType::Numeric: {
          vector<BindValue>* list =
            static_cast<vector<BindValue>*>(query_req->params);
          for (int index = 1;
               index <= nbinds && query_req->bind_list_pos < list->size();
               ++index) {
            if (!bind_value(query_req->cur_stmt,
                            index,
                            list->at(query_req->bind_list_pos++),
                            &res)) {
              query_req->last_status = StatementStatus::Error;
              query_req->last_error = strdup("Invalid bind param type");
              query_req->sqlite_status = -1;
              sqlite3_finalize(query_req->cur_stmt);
              query_req->cur_stmt = nullptr;
              return;
            }
            if (res != SQLITE_OK) {
              query_req->last_status = StatementStatus::Error;
              query_req->last_error =
                strdup(sqlite3_errmsg(query_req->handle_ptr->db_));
              query_req->sqlite_status = -1;
              sqlite3_finalize(query_req->cur_stmt);
              query_req->cur_stmt = nullptr;
              return;
            }
          }
          break;
        }
        default:
          // Appease the compiler
          break;
      }
    }
  }

  res = sqlite3_step(query_req->cur_stmt);
  if (res == SQLITE_ROW) {
    if (query_req->col_count) {
      if (is_new && !(query_req->query_flags & QueryFlag::RowsAsArray)) {
        vector<RowValue> cols(query_req->col_count);
        // Add the column names to the result set
        for (int i = 0; i < query_req->col_count; ++i) {
          const char* name = sqlite3_column_name(query_req->cur_stmt, i);
          int len = -1;
          while (name[++len]);
          if (len > 0) {
            cols[i].type = ValueType::String;
            cols[i].val = malloc(len);
            assert(cols[i].val != nullptr);
            memcpy(cols[i].val, name, len);
            cols[i].len = len;
          } else {
            cols[i].type = ValueType::StringEmpty;
          }
        }
        query_req->rows.push_back(std::move(cols));
      }

      // Add the rows to the result set
      size_t row_count = 0;
      do {
        vector<RowValue> row(query_req->col_count);
        for (int i = 0; i < query_req->col_count; ++i) {
          switch (sqlite3_column_type(query_req->cur_stmt, i)) {
            case SQLITE_NULL:
              row[i].type = ValueType::Null;
              break;
            case SQLITE_BLOB: {
              const void* data =
                sqlite3_column_blob(query_req->cur_stmt, i);
              int len = sqlite3_column_bytes(query_req->cur_stmt, i);
              if (len == 0) {
                row[i].type = ValueType::BlobEmpty;
              } else {
                row[i].type = ValueType::Blob;
                row[i].len = len;
                row[i].val = malloc(len);
                assert(row[i].val != nullptr);
                memcpy(row[i].val, data, len);
              }
              break;
            }
            default: {
              const char* text = reinterpret_cast<const char*>(
                sqlite3_column_text(query_req->cur_stmt, i)
              );
              int len = sqlite3_column_bytes(query_req->cur_stmt, i);
              if (len == 0) {
                row[i].type = ValueType::StringEmpty;
              } else {
                row[i].type = ValueType::String;
                row[i].val = malloc(len);
                assert(row[i].val != nullptr);
                memcpy(row[i].val, text, len);
                row[i].len = len;
              }
            }
          }
        }
        query_req->rows.push_back(std::move(row));
        ++row_count;
      } while ((query_req->max_rows == 0 || (row_count < query_req->max_rows))
               && (res = sqlite3_step(query_req->cur_stmt)) == SQLITE_ROW);
    } else {
      // No columns thus no row data, so just step until done
      while ((res = sqlite3_step(query_req->cur_stmt)) == SQLITE_ROW);
    }
  }
  if (res == SQLITE_ROW) {
    query_req->last_status = StatementStatus::Incomplete;
    return;
  }
  if (res == SQLITE_DONE) {
    query_req->last_status = StatementStatus::Complete;
  } else {
    query_req->last_status = StatementStatus::Error;
    query_req->last_error = strdup(sqlite3_errmsg(query_req->handle_ptr->db_));
    query_req->sqlite_status = res;
  }

  sqlite3_finalize(query_req->cur_stmt);
  query_req->cur_stmt = nullptr;
}

void QueryAfter(uv_work_t* req, int status) {
  Nan::HandleScope scope;
  QueryRequest* query_req = static_cast<QueryRequest*>(req->data);
  Local<Object> handle = Nan::New(query_req->handle);
  Local<Function> status_callback =
    Nan::New(query_req->handle_ptr->status_callback);
  Local<Function> make_rows_fn = Nan::New(query_req->handle_ptr->make_rows_fn);

  --query_req->handle_ptr->working_;

  Local<Array> rows;
  if (query_req->rows.size() > 0) {
    size_t row_start = (
      query_req->cur_stmt_rowfn.IsEmpty()
        && !(query_req->query_flags & QueryFlag::RowsAsArray)
      ? 1
      : 0
    );
    int ncols = query_req->col_count;
    size_t nrows = query_req->rows.size() - row_start;
    rows = Nan::New<Array>(nrows);

    // Note: `argv` is defined once to reduce the ifdefs and is large enough for
    //       any of the uses in this function
#define CHUNK_SIZE 30
#ifdef _MSC_VER
    Local<Value>* argv = static_cast<Local<Value>*>(
      _malloca((2 + (ncols * CHUNK_SIZE)) * sizeof(Local<Value>))
    );
#else
    Local<Value> argv[(2 + (ncols * CHUNK_SIZE))];
#endif

    Local<Function> rowFn;
    if (query_req->cur_stmt_rowfn.IsEmpty()) {
      // Create row generator
      if (!(query_req->query_flags & QueryFlag::RowsAsArray)) {
        for (int k = 0; k < ncols; ++k) {
          Local<Value> val;
          switch (query_req->rows[0][k].type) {
            case ValueType::String: {
              char* raw = static_cast<char*>(query_req->rows[0][k].val);
              size_t len = query_req->rows[0][k].len;
              if (len < EXTERN_APEX) {
                // Makes copy
                val = Nan::New(raw, len).ToLocalChecked();
                free(raw);
              } else {
                // Uses reference to existing memory
                val = Nan::New(new ExtString(raw, len)).ToLocalChecked();
              }
              break;
            }
            case ValueType::StringEmpty:
              val = Nan::EmptyString();
              break;
            default:
              // Appease compiler
              break;
          }
          argv[k] = val;
        }
        rowFn = Local<Function>::Cast(
          query_req->runInAsyncScope(
            rows,
            Nan::New(query_req->handle_ptr->make_obj_row_fn),
            ncols,
            argv
          ).ToLocalChecked()
        );
      } else {
        argv[0] = Nan::New(ncols);
        rowFn = Local<Function>::Cast(
          query_req->runInAsyncScope(
            rows,
            Nan::New(query_req->handle_ptr->make_arr_row_fn),
            1,
            argv
          ).ToLocalChecked()
        );
      }
      query_req->cur_stmt_rowfn.Reset(rowFn);
    } else {
      rowFn = Nan::New(query_req->cur_stmt_rowfn);
    }

    // Create rows
    {
      size_t j = row_start;
      while (true) {
        size_t chunk_size =
          min(nrows - (j - row_start), static_cast<size_t>(CHUNK_SIZE));
        if (chunk_size == 0)
          break;
        size_t end = j + chunk_size;

        int offset = 2;
        int argc = 2 + (ncols * chunk_size);
        argv[0] = Nan::New<Uint32>(static_cast<uint32_t>(j - row_start));
        argv[1] = rowFn;
        for (; j < end; ++j) {
          for (int k = 0; k < ncols; ++k) {
            Local<Value> val;
            switch (query_req->rows[j][k].type) {
              case ValueType::Null:
                val = Nan::Null();
                break;
              case ValueType::StringEmpty:
                val = Nan::EmptyString();
                break;
              case ValueType::BlobEmpty:
                val = Nan::NewBuffer(0).ToLocalChecked();
                break;
              case ValueType::Blob: {
                // Transfers ownership
                val = Nan::NewBuffer(
                  static_cast<char*>(query_req->rows[j][k].val),
                  query_req->rows[j][k].len
#ifdef _MSC_VER
                  ,
                  free_blob,
                  nullptr
#endif
                ).ToLocalChecked();
                break;
              }
              default: {
                char* raw =
                  static_cast<char*>(query_req->rows[j][k].val);
                size_t len = query_req->rows[j][k].len;
                if (len < EXTERN_APEX) {
                  // Makes copy
                  val = Nan::New(raw, len).ToLocalChecked();
                  free(raw);
                } else {
                  // Uses reference to existing memory
                  val = Nan::New(new ExtString(raw, len)).ToLocalChecked();
                }
              }
            }
            argv[offset++] = val;
          }
        }
        query_req->runInAsyncScope(rows, make_rows_fn, argc, argv);
      }
    }

#ifdef _MSC_VER
    _freea(argv);
#endif
  }

  bool is_last_stmt = (
    query_req->sql_remaining == 0
    || (query_req->query_flags & QueryFlag::SingleStatement)
  );
  Local<Value> argv[4];
  argv[0] = Nan::New(query_req->last_status);
  argv[1] = Nan::New(is_last_stmt);
  switch (query_req->last_status) {
    case StatementStatus::Done:
    case StatementStatus::Complete:
      query_req->cur_stmt_rowfn.Reset();
      // FALLTHROUGH
    case StatementStatus::Incomplete: {
      if (rows.IsEmpty())
        argv[2] = Nan::Undefined();
      else
        argv[2] = rows;
      break;
    }
    case StatementStatus::Error: {
      query_req->cur_stmt_rowfn.Reset();
      argv[2] = Nan::Error(query_req->last_error);
      if (query_req->sqlite_status >= 0) {
        Nan::Set(
          Nan::To<Object>(argv[2]).ToLocalChecked(),
          Nan::New("code").ToLocalChecked(),
          esqlite_err_name(query_req->sqlite_status)
        ).FromJust();
      }
      free(query_req->last_error);
      query_req->last_error = nullptr;
      break;
    }
    default:
      Nan::ThrowError("Unexpected init statement status");
  }
  argv[3] = Nan::New(query_req->col_count);

  bool req_done = (
    is_last_stmt && query_req->last_status != StatementStatus::Incomplete
  );
  query_req->active = false;
  query_req->rows.clear();
  if (req_done)
    query_req->handle_ptr->cur_req = nullptr;

  query_req->runInAsyncScope(handle, status_callback, 4, argv);

  if (req_done && !query_req->defer_delete)
    delete query_req;
}

class InterruptRequest : public Nan::AsyncResource {
public:
  InterruptRequest(Local<Object> handle_,
                   DBHandle* handle_ptr_,
                   Local<Function> callback_)
    : Nan::AsyncResource("esqlite:InterruptRequest"),
      handle_ptr(handle_ptr_) {
    handle.Reset(handle_);
    callback.Reset(callback_);
    request.data = this;
  }

  ~InterruptRequest() {
    handle.Reset();
    callback.Reset();
  }

  uv_work_t request;

  Nan::Persistent<Object> handle;
  DBHandle* handle_ptr;

  Nan::Persistent<Function> callback;
};

void InterruptWork(uv_work_t* req) {
  InterruptRequest* intr_req = static_cast<InterruptRequest*>(req->data);
  sqlite3_interrupt(intr_req->handle_ptr->db_);
}

void InterruptAfter(uv_work_t* req, int status) {
  Nan::HandleScope scope;
  InterruptRequest* intr_req = static_cast<InterruptRequest*>(req->data);
  Local<Object> handle = Nan::New(intr_req->handle);
  Local<Function> callback = Nan::New(intr_req->callback);
  --intr_req->handle_ptr->working_;

  intr_req->runInAsyncScope(handle, callback, 0, nullptr);

  delete intr_req;
}

class FinalizeRequest : public Nan::AsyncResource {
public:
  FinalizeRequest(Local<Object> handle_,
                  QueryRequest* query_req_,
                  bool delete_query_req_,
                  Local<Function> callback_)
    : Nan::AsyncResource("esqlite:FinalizeRequest"),
      query_req(query_req_),
      delete_query_req(delete_query_req_) {
    handle.Reset(handle_);
    callback.Reset(callback_);
    request.data = this;
  }

  ~FinalizeRequest() {
    handle.Reset();
    callback.Reset();
    if (delete_query_req)
      delete query_req;
  }

  uv_work_t request;

  Nan::Persistent<Object> handle;
  Nan::Persistent<Function> callback;
  QueryRequest* query_req;
  bool delete_query_req;
};

void FinalizeWork(uv_work_t* req) {
  FinalizeRequest* final_req = static_cast<FinalizeRequest*>(req->data);
  sqlite3_finalize(final_req->query_req->cur_stmt);
  final_req->query_req->cur_stmt = nullptr;
}

void FinalizeAfter(uv_work_t* req, int status) {
  Nan::HandleScope scope;
  FinalizeRequest* final_req = static_cast<FinalizeRequest*>(req->data);
  Local<Object> handle = Nan::New(final_req->handle);
  Local<Function> callback = Nan::New(final_req->callback);
  --final_req->query_req->handle_ptr->working_;
  final_req->query_req->cur_stmt_rowfn.Reset();

  final_req->runInAsyncScope(handle, callback, 0, nullptr);

  delete final_req;
}

int sqlite_authorizer(void* baton, int code, const char* arg1, const char* arg2,
                      const char* arg3, const char* arg4) {
  AuthorizerRequest* req = static_cast<AuthorizerRequest*>(baton);

  if (req->filter.size() > 0 && req->filter.count(code) == 0)
    return req->nomatch_result;

  int result;
  uv_mutex_lock(&req->mutex);
  req->code = code;
  req->arg1 = arg1;
  req->arg2 = arg2;
  req->arg3 = arg3;
  req->arg4 = arg4;
  req->result = -1;

  int status = uv_async_send(&req->async);
  assert(status == 0);

  while (req->result == -1)
    uv_cond_wait(&req->cond, &req->mutex);
  result = req->result;

  uv_mutex_unlock(&req->mutex);
  return result;
}

int sqlite_authorizer_simple(void* baton, int code, const char* arg1,
                             const char* arg2, const char* arg3,
                             const char* arg4) {
  AuthorizerRequest* req = static_cast<AuthorizerRequest*>(baton);
  return (
    req->filter.size() > 0 && req->filter.count(code) > 0
    ? req->match_result
    : req->nomatch_result
  );
}

DBHandle::DBHandle(Local<Function> make_rows_fn_,
                   Local<Function> make_obj_row_fn_,
                   Local<Function> make_arr_row_fn_,
                   Local<Function> status_callback_)
  : db_(nullptr), working_(0), cur_req(nullptr), authorizeReq(nullptr) {
  make_rows_fn.Reset(make_rows_fn_);
  make_obj_row_fn.Reset(make_obj_row_fn_);
  make_arr_row_fn.Reset(make_arr_row_fn_);
  status_callback.Reset(status_callback_);
}
DBHandle::~DBHandle() {
  if (db_)
    sqlite3_close_v2(db_);
  make_rows_fn.Reset();
  make_obj_row_fn.Reset();
  make_arr_row_fn.Reset();
  if (authorizeReq)
    authorizeReq->close();
  status_callback.Reset();
}

NAN_METHOD(DBHandle::New) {
  if (!info.IsConstructCall())
    return Nan::ThrowError("Use `new` to create instances");

  Local<Value> auth_fn = info[3];
  Local<Value> auth_filter = info[4];
  Local<Value> auth_match_result = info[5];
  Local<Value> auth_nomatch_result = info[6];

  DBHandle* obj = new DBHandle(
    Local<Function>::Cast(info[0]),
    Local<Function>::Cast(info[1]),
    Local<Function>::Cast(info[2]),
    Local<Function>::Cast(info[7])
  );
  obj->Wrap(info.This());

  if (auth_fn->IsFunction()) {
    obj->authorizeReq = new AuthorizerRequest(
      sqlite_authorizer,
      Local<Function>::Cast(auth_fn)
    );
    if (!auth_filter->IsUndefined()) {
      if (!auth_filter->IsArray()) {
        delete obj;
        return Nan::ThrowError("Invalid authorizer filter value");
      }

      Local<Array> filter_arr = Local<Array>::Cast(auth_filter);
      for (uint32_t i = 0; i < filter_arr->Length(); ++i) {
        Local<Value> val = Nan::Get(filter_arr, i).ToLocalChecked();
        if (!val->IsUint32()) {
          delete obj;
          return Nan::ThrowError("Invalid authorizer filter array value");
        }
        int32_t num_val = Nan::To<int32_t>(val).FromJust();
        if (num_val < 0) {
          delete obj;
          return Nan::ThrowError("Invalid authorizer filter array value");
        }
        obj->authorizeReq->filter.insert(num_val);
      }

      if (auth_nomatch_result->IsTrue()) {
        obj->authorizeReq->nomatch_result = SQLITE_OK;
      } else if (auth_nomatch_result->IsFalse()) {
        obj->authorizeReq->nomatch_result = SQLITE_DENY;
      } else if (auth_nomatch_result->IsNull()) {
        obj->authorizeReq->nomatch_result = SQLITE_IGNORE;
      } else {
        delete obj;
        return Nan::ThrowError("Invalid authorizer no-match result value");
      }
    }
  } else if (auth_fn->IsTrue()) {
    obj->authorizeReq = new AuthorizerRequest(sqlite_authorizer_simple);
    if (!auth_filter->IsUndefined()) {
      if (!auth_filter->IsArray()) {
        delete obj;
        return Nan::ThrowError("Invalid authorizer filter value");
      }

      Local<Array> filter_arr = Local<Array>::Cast(auth_filter);
      for (uint32_t i = 0; i < filter_arr->Length(); ++i) {
        Local<Value> val = Nan::Get(filter_arr, i).ToLocalChecked();
        if (!val->IsUint32()) {
          delete obj;
          return Nan::ThrowError("Invalid authorizer filter array value");
        }
        int32_t num_val = Nan::To<int32_t>(val).FromJust();
        if (num_val < 0) {
          delete obj;
          return Nan::ThrowError("Invalid authorizer filter array value");
        }
        obj->authorizeReq->filter.insert(num_val);
      }
    }

    if (auth_nomatch_result->IsTrue()) {
      obj->authorizeReq->nomatch_result = SQLITE_OK;
    } else if (auth_nomatch_result->IsFalse()) {
      obj->authorizeReq->nomatch_result = SQLITE_DENY;
    } else if (auth_nomatch_result->IsNull()) {
      obj->authorizeReq->nomatch_result = SQLITE_IGNORE;
    } else {
      delete obj;
      return Nan::ThrowError("Invalid authorizer no-match result value");
    }

    if (obj->authorizeReq->filter.size() > 0) {
      if (auth_match_result->IsTrue()) {
        obj->authorizeReq->match_result = SQLITE_OK;
      } else if (auth_match_result->IsFalse()) {
        obj->authorizeReq->match_result = SQLITE_DENY;
      } else if (auth_match_result->IsNull()) {
        obj->authorizeReq->match_result = SQLITE_IGNORE;
      } else {
        delete obj;
        return Nan::ThrowError("Invalid authorizer match result value");
      }
    }
  }

  info.GetReturnValue().Set(info.This());
}

NAN_METHOD(DBHandle::Open) {
  DBHandle* self = Nan::ObjectWrap::Unwrap<DBHandle>(info.Holder());

  if (self->db_)
    return Nan::ThrowError("Database already open, close first");

  Nan::Utf8String filename(info[0]);
  uint32_t flags = Nan::To<uint32_t>(info[1]).FromJust();
  flags |= SQLITE_OPEN_NOMUTEX;

  int res = sqlite3_open_v2(*filename, &self->db_, flags, nullptr);
  if (res != SQLITE_OK)
    goto on_err;

  res = sqlite3_extended_result_codes(self->db_, 1);
  if (res != SQLITE_OK)
    goto on_err;

  // Disable dynamic loading of extensions
  res = sqlite3_db_config(self->db_,
                          SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION,
                          0,
                          nullptr);
  if (res != SQLITE_OK)
    goto on_err;

  // Disable language features that allow ordinary SQL to deliberately corrupt
  // the database
  res = sqlite3_db_config(self->db_,
                          SQLITE_DBCONFIG_DEFENSIVE,
                          1,
                          nullptr);
  if (res != SQLITE_OK)
    goto on_err;

  if (self->authorizeReq) {
    res = sqlite3_set_authorizer(
      self->db_,
      self->authorizeReq->sqlite_auth_callback,
      self->authorizeReq
    );
    if (res != SQLITE_OK)
      goto on_err;
  }

  return;

on_err:
  Local<Value> err = Nan::Error(sqlite3_errstr(res));
  if (self->db_) {
    sqlite3_close_v2(self->db_);
    self->db_ = nullptr;
  }
  Nan::ThrowError(err);
}

NAN_METHOD(DBHandle::Query) {
  DBHandle* self = Nan::ObjectWrap::Unwrap<DBHandle>(info.Holder());

  if (!self->db_)
    return Nan::ThrowError("Database not open");

  if (info.Length() == 0 || info.Length() == 1) {
    if (!self->cur_req)
      return Nan::ThrowError("No query in progress");
    if (self->cur_req->active)
      return Nan::ThrowError("Query already working");
    if (info.Length() == 1)
      self->cur_req->max_rows = Nan::To<uint32_t>(info[0]).FromJust();
  } else if (self->cur_req) {
    return Nan::ThrowError("Query still in progress");
  } else {
    uint32_t prepare_flags = Nan::To<uint32_t>(info[1]).FromJust();
    uint32_t query_flags = Nan::To<uint32_t>(info[2]).FromJust();
    uint32_t max_rows = Nan::To<uint32_t>(info[4]).FromJust();

    BindParamsType params_type;
    void* params;
    if (info[3]->IsArray()) {
      Local<Array> param_list = Local<Array>::Cast(info[3]);
      if (query_flags & QueryFlag::NamedParams) {
        // [ key1, val1, key2, val2, ... ]
        params_type = BindParamsType::Named;
        NamedParamsMap* map = new NamedParamsMap();
        for (uint32_t i = 0; i < param_list->Length(); i += 2) {
          BindValue bv;
          Local<Value> js_key = Nan::Get(param_list, i).ToLocalChecked();
          Nan::Utf8String key_str(js_key);
          Local<Value> js_val = Nan::Get(param_list, i + 1).ToLocalChecked();
          if (!set_bind_value(bv, js_val)) {
            delete map;
            string msg = "Unsupported value for bind parameter \"";
            msg += *key_str;
            msg += "\": ";
            Nan::Utf8String val_str(js_val);
            msg += *val_str;
            return Nan::ThrowError(Nan::New(msg).ToLocalChecked());
          }
          map->emplace(make_pair(string(*key_str, key_str.length()), bv));
        }
        params = map;
      } else {
        // [ val1, val2, .... ]
        params_type = BindParamsType::Numeric;
        vector<BindValue>* bind_values =
          new vector<BindValue>(param_list->Length());
        for (uint32_t i = 0; i < param_list->Length(); ++i) {
          Local<Value> js_val = Nan::Get(param_list, i).ToLocalChecked();
          if (!set_bind_value(bind_values->at(i), js_val)) {
            delete bind_values;
            string msg = "Unsupported value for bind parameter at position ";
            msg += to_string(i);
            msg += ": ";
            Nan::Utf8String val_str(js_val);
            msg += *val_str;
            return Nan::ThrowError(Nan::New(msg).ToLocalChecked());
          }
        }
        params = bind_values;
      }
    } else {
      params_type = BindParamsType::None;
      params = nullptr;
    }

    self->cur_req = new QueryRequest(info.Holder(),
                                     self,
                                     info[0],
                                     params_type,
                                     params,
                                     prepare_flags,
                                     query_flags,
                                     max_rows);
  }

  ++self->working_;
  self->cur_req->active = true;

  int status = uv_queue_work(
    uv_default_loop(),
    &self->cur_req->request,
    QueryWork,
    reinterpret_cast<uv_after_work_cb>(QueryAfter)
  );
  assert(status == 0);
}

NAN_METHOD(DBHandle::AutoCommit) {
  DBHandle* self = Nan::ObjectWrap::Unwrap<DBHandle>(info.Holder());

  if (!self->db_)
    return Nan::ThrowError("Database not open");

  info.GetReturnValue().Set(Nan::New(!!sqlite3_get_autocommit(self->db_)));
}

NAN_METHOD(DBHandle::Limit) {
  DBHandle* self = Nan::ObjectWrap::Unwrap<DBHandle>(info.Holder());

  if (!self->db_)
    return Nan::ThrowError("Database not open");

  int32_t type = Nan::To<int32_t>(info[0]).FromJust();
  int32_t new_limit = Nan::To<int32_t>(info[1]).FromJust();
  info.GetReturnValue().Set(
    Nan::New(sqlite3_limit(self->db_, type, new_limit))
  );
}

NAN_METHOD(DBHandle::Interrupt) {
  DBHandle* self = Nan::ObjectWrap::Unwrap<DBHandle>(info.Holder());

  if (!self->db_)
    return Nan::ThrowError("Database not open");

  Local<Function> callback = Local<Function>::Cast(info[0]);

  ++self->working_;
  InterruptRequest* intr_req = new InterruptRequest(info.Holder(),
                                                    self,
                                                    callback);

  int status = uv_queue_work(
    uv_default_loop(),
    &intr_req->request,
    InterruptWork,
    reinterpret_cast<uv_after_work_cb>(InterruptAfter)
  );
  assert(status == 0);
}

NAN_METHOD(DBHandle::Abort) {
  DBHandle* self = Nan::ObjectWrap::Unwrap<DBHandle>(info.Holder());

  if (!info[0]->IsBoolean())
    return Nan::ThrowTypeError("Complete abort argument must be a boolean");
  if (!info[1]->IsFunction())
    return Nan::ThrowTypeError("Callback argument must be a function");

  QueryRequest* req = self->cur_req;
  if (self->db_ && req && !req->active) {
    Local<Value> is_abort_all = info[0];
    Local<Function> callback = Local<Function>::Cast(info[1]);

    if (req->sql_remaining == 0
        || (req->query_flags & QueryFlag::SingleStatement)
        || is_abort_all->IsTrue()) {
      req->defer_delete = true;
    }

    if (is_abort_all->IsTrue()) {
      // Skip current and any remaining statements
      self->cur_req = nullptr;
    }

    ++self->working_;
    FinalizeRequest* final_req =
      new FinalizeRequest(info.Holder(), req, req->defer_delete, callback);

    int status = uv_queue_work(
      uv_default_loop(),
      &final_req->request,
      FinalizeWork,
      reinterpret_cast<uv_after_work_cb>(FinalizeAfter)
    );
    assert(status == 0);

    return info.GetReturnValue().Set(Nan::True());
  }

  info.GetReturnValue().Set(Nan::False());
}

NAN_METHOD(DBHandle::Close) {
  DBHandle* self = Nan::ObjectWrap::Unwrap<DBHandle>(info.Holder());

  if (!self->db_)
    return;

  if (self->working_)
    return Nan::ThrowError("Cannot close database with active requests");

  int res = sqlite3_close_v2(self->db_);
  if (res != SQLITE_OK)
    return Nan::ThrowError(sqlite3_errstr(res));
  if (self->authorizeReq) {
    self->authorizeReq->close();
    self->authorizeReq = nullptr;
  }

  self->db_ = nullptr;
}

NAN_METHOD(Version) {
#define xstr(s) str(s)
#define str(s) #s
  static const char* ver_str = SQLITE_VERSION " / MC "
                               xstr(SQLITE3MC_VERSION_MAJOR) "."
                               xstr(SQLITE3MC_VERSION_MINOR) "."
                               xstr(SQLITE3MC_VERSION_RELEASE) "."
                               xstr(SQLITE3MC_VERSION_SUBRELEASE) "-"
                               xstr(SQLITE3MC_VERSION_REV);
#undef str
#undef xstr
  info.GetReturnValue().Set(Nan::New(ver_str).ToLocalChecked());
}




NAN_MODULE_INIT(init) {
  static bool is_initialized = false;
  if (!is_initialized) {
    int res = sqlite3_initialize();
    if (res != SQLITE_OK)
      return Nan::ThrowError("Unable to initialize SQLite");
    is_initialized = true;
  }

  Local<FunctionTemplate> tpl = Nan::New<FunctionTemplate>(DBHandle::New);
  tpl->SetClassName(Nan::New("DBHandle").ToLocalChecked());
  tpl->InstanceTemplate()->SetInternalFieldCount(1);

  Nan::SetPrototypeMethod(tpl, "open", DBHandle::Open);
  Nan::SetPrototypeMethod(tpl, "query", DBHandle::Query);
  Nan::SetPrototypeMethod(tpl, "autoCommitEnabled", DBHandle::AutoCommit);
  Nan::SetPrototypeMethod(tpl, "limit", DBHandle::Limit);
  Nan::SetPrototypeMethod(tpl, "interrupt", DBHandle::Interrupt);
  Nan::SetPrototypeMethod(tpl, "abort", DBHandle::Abort);
  Nan::SetPrototypeMethod(tpl, "close", DBHandle::Close);

  Local<Function> ctor = Nan::GetFunction(tpl).ToLocalChecked();
  DBHandle::constructor().Set(Nan::GetCurrentContext()->GetIsolate(), ctor);

  Nan::Set(target, Nan::New("DBHandle").ToLocalChecked(), ctor);

  Nan::Export(target, "version", Version);
}

NAN_MODULE_WORKER_ENABLED(esqlite3, init)
