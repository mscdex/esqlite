#include <node.h>
#include <node_buffer.h>
#include <nan.h>
#include <unordered_map>
#ifdef _MSC_VER
# include <malloc.h>
#endif

#include <sqlite3mc_amalgamation.h>

using namespace node;
using namespace v8;
using namespace std;

enum QueryFlag : uint32_t {
  SingleStatement = 0x01,
  NamedParams = 0x02,
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

class BindValueStringUTF8 {
  public:
    BindValueStringUTF8(Local<Value>& str_, int len_)
      : str(str_), len(len_) {}
    ~BindValueStringUTF8() {}

    Nan::Utf8String str;
    int len;
};

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
  const char* data() const { return data_; }
  size_t length() const { return len_; }

  char* data_;
  size_t len_;
};

class DBHandle : public Nan::ObjectWrap {
 public:
  explicit DBHandle();
  ~DBHandle();

  static NAN_METHOD(New);
  static NAN_METHOD(Open);
  static NAN_METHOD(Query);
  static NAN_METHOD(AutoCommit);
  static NAN_METHOD(Interrupt);
  static NAN_METHOD(Close);
  static inline Nan::Persistent<Function> & constructor() {
    static Nan::Persistent<Function> my_constructor;
    return my_constructor;
  }

  sqlite3* db_;
  size_t working_;
  Nan::Persistent<Function> makeRowFn;
  Nan::Persistent<Function> makeObjectRowFn;
};

class QueryRequest : public Nan::AsyncResource {
public:
  QueryRequest(Local<Object> handle_,
               DBHandle* handle_ptr_,
               Local<Value> sql_str_,
               BindParamsType params_type_,
               void* params_,
               unsigned int prepare_flags_,
               bool single_query_,
               Local<Function> callback_)
    : Nan::AsyncResource("esqlite:QueryRequest"),
      handle_ptr(handle_ptr_),
      sql_utf8str(sql_str_),
      params_type(params_type_),
      params(params_),
      prepare_flags(prepare_flags_),
      single_query(single_query_),
      error_count(0) {
    sql_len = sql_utf8str.length();
    sql_str.Reset(sql_str_);
    handle.Reset(handle_);
    callback.Reset(callback_);
    request.data = this;
  }

  ~QueryRequest() {
    handle.Reset();
    callback.Reset();
    sql_str.Reset();
  }

  uv_work_t request;

  Nan::Persistent<Object> handle;
  DBHandle* handle_ptr;

  Nan::Persistent<Value> sql_str;
  Nan::Utf8String sql_utf8str;
  size_t sql_len;

  BindParamsType params_type;
  void* params;

  unsigned int prepare_flags;
  Nan::Callback callback;
  bool single_query;

  vector<vector<vector<RowValue>>> results;
  vector<char*> errors;
  size_t error_count;

  /*sqlite3_int64 last_insert_id;
  int total_changes;
  int changes;*/
};

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
      BindValueStringUTF8* str = static_cast<BindValueStringUTF8*>(bv.val);
      *res = sqlite3_bind_text(stmt, index, *str->str, str->len, SQLITE_STATIC);
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
      BindValueStringUTF8* str = static_cast<BindValueStringUTF8*>(bv.val);
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
    int len = str->Length();
    if (len == 0) {
      bv.type = ValueType::StringEmpty;
    } else {
      bv.type = ValueType::String;
      bv.val = new BindValueStringUTF8(val, len);
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

void QueryWork(uv_work_t* req) {
  QueryRequest* query_req = static_cast<QueryRequest*>(req->data);

  const char* sql = *(query_req->sql_utf8str);
  const char* sql_pos = sql;
  size_t sql_len = query_req->sql_len;

  size_t bind_list_pos = 0;
  while (sql_len) {
    sqlite3_stmt* stmt;
    const char* new_pos;
    int res = sqlite3_prepare_v3(query_req->handle_ptr->db_,
                                 sql_pos,
                                 sql_len,
                                 query_req->prepare_flags,
                                 &stmt,
                                 &new_pos);
    vector<vector<RowValue>> result_set;
    if (res != SQLITE_OK) {
      ++query_req->error_count;
      query_req->errors.push_back(
        strdup(sqlite3_errmsg(query_req->handle_ptr->db_))
      );
      query_req->results.push_back(std::move(result_set));
      if (stmt)
        sqlite3_finalize(stmt);
      break;
    }

    if (stmt) {
      // Bind any parameters
      int nbinds = sqlite3_bind_parameter_count(stmt);
      if (nbinds > 0) {
        switch (query_req->params_type) {
          case BindParamsType::Named: {
            NamedParamsMap* map =
              static_cast<NamedParamsMap*>(query_req->params);
            for (int index = 1; index <= nbinds; ++index) {
              const char* name = sqlite3_bind_parameter_name(stmt, index);
              if (name == nullptr)
                continue;

              // TODO: switch to map keyed on C string instead to avoid copying
              //       of parameter name?
              auto it = map->find(string(name));

              if (it == map->end())
                continue;

              if (!bind_value(stmt, index, it->second, &res)) {
                ++query_req->error_count;
                query_req->errors.push_back(strdup("Invalid bind param type"));
                query_req->results.push_back(std::move(result_set));
                sqlite3_finalize(stmt);
                return;
              }
              if (res != SQLITE_OK) {
                ++query_req->error_count;
                query_req->errors.push_back(
                  strdup(sqlite3_errmsg(query_req->handle_ptr->db_))
                );
                query_req->results.push_back(std::move(result_set));
                sqlite3_finalize(stmt);
                return;
              }
            }
            break;
          }
          case BindParamsType::Numeric: {
            vector<BindValue>* list =
              static_cast<vector<BindValue>*>(query_req->params);
            for (int index = 1;
                 index <= nbinds && bind_list_pos < list->size();
                 ++index) {
              if (!bind_value(stmt, index, list->at(bind_list_pos++), &res)) {
                ++query_req->error_count;
                query_req->errors.push_back(
                  strdup("Invalid bind param type")
                );
                query_req->results.push_back(std::move(result_set));
                sqlite3_finalize(stmt);
                return;
              }
              if (res != SQLITE_OK) {
                ++query_req->error_count;
                query_req->errors.push_back(
                  strdup(sqlite3_errmsg(query_req->handle_ptr->db_))
                );
                query_req->results.push_back(std::move(result_set));
                sqlite3_finalize(stmt);
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

      res = sqlite3_step(stmt);
      if (res == SQLITE_ROW) {
        int col_count = sqlite3_data_count(stmt);
        vector<RowValue> cols(col_count);
        if (col_count) {
          // Add the column names to the result set
          for (int i = 0; i < col_count; ++i) {
            const char* name = sqlite3_column_name(stmt, i);
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
          result_set.push_back(std::move(cols));

          // Add the rows to the result set
          do {
            vector<RowValue> row(col_count);
            for (int i = 0; i < col_count; ++i) {
              switch (sqlite3_column_type(stmt, i)) {
                case SQLITE_NULL:
                  row[i].type = ValueType::Null;
                  break;
                case SQLITE_BLOB: {
                  const void* data = sqlite3_column_blob(stmt, i);
                  int len = sqlite3_column_bytes(stmt, i);
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
                    sqlite3_column_text(stmt, i)
                  );
                  int len = sqlite3_column_bytes(stmt, i);
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
            result_set.push_back(std::move(row));
          } while ((res = sqlite3_step(stmt)) == SQLITE_ROW);
        } else {
          result_set.push_back(std::move(cols));
          // No columns thus no row data, so just step until done
          while ((res = sqlite3_step(stmt)) == SQLITE_ROW);
        }
      }
    } else {
      res = SQLITE_DONE;
    }

    if (res == SQLITE_DONE) {
      query_req->errors.push_back(nullptr);
    } else {
      ++query_req->error_count;
      query_req->errors.push_back(
        strdup(sqlite3_errmsg(query_req->handle_ptr->db_))
      );
    }
    query_req->results.push_back(std::move(result_set));
    if (stmt)
      sqlite3_finalize(stmt);
    else
      break;

    if (query_req->single_query)
      break;

    // Move to the next query in the sql string
    sql_len -= (new_pos - sql_pos);
    sql_pos = new_pos;
  }

  // TODO: store these per result set? opt-in only?
  /*query_req->last_insert_id =
    sqlite3_last_insert_rowid(query_req->handle_ptr->db_);
  query_req->total_changes =
    sqlite3_total_changes(query_req->handle_ptr->db_);
  query_req->changes = sqlite3_changes(query_req->handle_ptr->db_);*/
}

void QueryAfter(uv_work_t* req) {
  Nan::HandleScope scope;
  QueryRequest* query_req = static_cast<QueryRequest*>(req->data);
  Local<Object> handle = Nan::New(query_req->handle);
  Local<Function> callback = query_req->callback.GetFunction();
  Local<Function> makeRowFn = Nan::New(query_req->handle_ptr->makeRowFn);
  Local<Function> makeObjectRowFn =
    Nan::New(query_req->handle_ptr->makeObjectRowFn);
  --query_req->handle_ptr->working_;

  switch (query_req->params_type) {
    case BindParamsType::Named: {
      NamedParamsMap* map = static_cast<NamedParamsMap*>(query_req->params);
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
        static_cast<vector<BindValue>*>(query_req->params);
      for (size_t i = 0; i < list->size(); ++i)
        bind_value_cleanup(list->at(i));
      delete list;
      break;
    }
    default:
      // Appease compiler
      break;
  }

  Local<Value> cb_argv[2];

  Local<Array> errs;
  if (query_req->error_count)
    errs = Nan::New<Array>(query_req->errors.size());

  Local<Array> results;
  if (query_req->error_count == query_req->errors.size()) {
    // All errors, no results
    for (size_t i = 0; i < query_req->errors.size(); ++i) {
      // TODO: attach code name/value to error object
      Local<Value> err = Nan::Error(query_req->errors[i]);
      free(query_req->errors[i]);
      Nan::Set(errs, i, err);
    }
    cb_argv[0] = errs;
    cb_argv[1] = Nan::Null();
  } else {
    results = Nan::New<Array>(query_req->results.size());
    for (size_t i = 0; i < query_req->results.size(); ++i) {
      if (query_req->errors[i]) {
        // TODO: attach code name/value to error object
        Local<Value> err = Nan::Error(query_req->errors[i]);
        free(query_req->errors[i]);
        Nan::Set(errs, i, err);
        Nan::Set(results, i, Nan::Null());
        continue;
      }

      Local<Array> rows = Nan::New<Array>(query_req->results[i].size() - 1);
      Local<Function> rowFn;
      for (size_t j = 0; j < query_req->results[i].size(); ++j) {
        int len = query_req->results[i][j].size();
        if (len == 0)
          break;
        int argc = (j == 0 /* Column names */ ? len : 2 + len);
        int offset = (j == 0 /* Column names */ ? 0 : 2);
#ifdef _MSC_VER
        Local<Value>* argv =
            static_cast<Local<Value>*>(_malloca(argc * sizeof(Local<Value>)));
#else
        Local<Value> argv[argc];
#endif
        if (j != 0) {
          // Row data
          argv[0] = Nan::New<Uint32>(static_cast<uint32_t>(j - 1));
          argv[1] = rowFn;
        }
        for (int k = 0; k < len; ++k) {
          Local<Value> val;
          switch (query_req->results[i][j][k].type) {
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
                static_cast<char*>(query_req->results[i][j][k].val),
                query_req->results[i][j][k].len
              ).ToLocalChecked();
              break;
            }
            default: {
              char* raw = static_cast<char*>(query_req->results[i][j][k].val);
              size_t len = query_req->results[i][j][k].len;
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
          argv[offset + k] = val;
        }
        if (j == 0) {
          // Column names
          rowFn = Local<Function>::Cast(
            query_req->runInAsyncScope(rows, makeObjectRowFn, argc, argv)
                                      .ToLocalChecked()
          );
        } else {
          // Row data
          query_req->runInAsyncScope(rows, makeRowFn, argc, argv);
        }
#ifdef _MSC_VER
        _freea(argv);
#endif
      }
      Nan::Set(results, i, rows);
    }

    if (query_req->error_count)
      cb_argv[0] = errs;
    else
      cb_argv[0] = Nan::Null();
    cb_argv[1] = results;
  }

  query_req->runInAsyncScope(handle, callback, 2, cb_argv);

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

  Nan::Callback callback;
};

void InterruptWork(uv_work_t* req) {
  InterruptRequest* intr_req = static_cast<InterruptRequest*>(req->data);
  sqlite3_interrupt(intr_req->handle_ptr->db_);
}

void InterruptAfter(uv_work_t* req) {
  Nan::HandleScope scope;
  InterruptRequest* intr_req = static_cast<InterruptRequest*>(req->data);
  Local<Object> handle = Nan::New(intr_req->handle);
  Local<Function> callback = intr_req->callback.GetFunction();
  --intr_req->handle_ptr->working_;

  intr_req->runInAsyncScope(handle, callback, 0, nullptr);

  delete intr_req;
}

DBHandle::DBHandle() : db_(nullptr), working_(0) {
}
DBHandle::~DBHandle() {
  sqlite3_close_v2(db_);
  makeRowFn.Reset();
  makeObjectRowFn.Reset();
}

NAN_METHOD(DBHandle::New) {
  if (!info.IsConstructCall())
    return Nan::ThrowError("Use `new` to create instances");
  DBHandle* obj = new DBHandle();
  obj->Wrap(info.This());
  obj->makeRowFn.Reset(Local<Function>::Cast(info[0]));
  obj->makeObjectRowFn.Reset(Local<Function>::Cast(info[1]));
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
    return Nan::ThrowError(sqlite3_errstr(res));

  res = sqlite3_extended_result_codes(self->db_, 1);
  if (res != SQLITE_OK)
    return Nan::ThrowError(sqlite3_errstr(res));

  // Disable load_extension() SQL function, but leave C API enabled
  // TODO: is it safe to set to 0 and still have all extensions (including
  //       cipher/crypto work properly?)
  res = sqlite3_db_config(self->db_,
                          SQLITE_DBCONFIG_ENABLE_LOAD_EXTENSION,
                          1,
                          nullptr);
  if (res != SQLITE_OK)
    return Nan::ThrowError(sqlite3_errstr(res));

  // Disable language features that allow ordinary SQL to deliberately corrupt
  // the database
  res = sqlite3_db_config(self->db_,
                          SQLITE_DBCONFIG_DEFENSIVE,
                          1,
                          nullptr);
  if (res != SQLITE_OK)
    return Nan::ThrowError(sqlite3_errstr(res));
}

NAN_METHOD(DBHandle::Query) {
  DBHandle* self = Nan::ObjectWrap::Unwrap<DBHandle>(info.Holder());

  if (!self->db_)
    return Nan::ThrowError("Database not open");

  uint32_t prepare_flags = Nan::To<uint32_t>(info[1]).FromJust();
  uint32_t query_flags = Nan::To<uint32_t>(info[2]).FromJust();
  Local<Function> callback = Local<Function>::Cast(info[4]);

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

  bool single_stmt = ((query_flags & QueryFlag::SingleStatement) > 0);

  ++self->working_;
  QueryRequest* query_req = new QueryRequest(info.Holder(),
                                             self,
                                             info[0],
                                             params_type,
                                             params,
                                             prepare_flags,
                                             single_stmt,
                                             callback);

  int status = uv_queue_work(
    uv_default_loop(),
    &query_req->request,
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

NAN_METHOD(DBHandle::Close) {
  DBHandle* self = Nan::ObjectWrap::Unwrap<DBHandle>(info.Holder());

  if (!self->db_)
    return;

  if (self->working_)
    return Nan::ThrowError("Cannot close database while executing queries");

  int res = sqlite3_close_v2(self->db_);
  if (res != SQLITE_OK)
    return Nan::ThrowError(sqlite3_errstr(res));

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
  Nan::SetPrototypeMethod(tpl, "interrupt", DBHandle::Interrupt);
  Nan::SetPrototypeMethod(tpl, "close", DBHandle::Close);

  DBHandle::constructor().Reset(Nan::GetFunction(tpl).ToLocalChecked());

  Nan::Set(target,
           Nan::New("DBHandle").ToLocalChecked(),
           Nan::GetFunction(tpl).ToLocalChecked());

  Nan::Export(target, "version", Version);
}

NAN_MODULE_WORKER_ENABLED(esqlite3, init)
