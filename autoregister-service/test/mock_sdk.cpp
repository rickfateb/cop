// Simulates ABI calls and callbacks. Does not implement the DVR network protocol.
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <string>
#include "dhnetsdk.h"
namespace {
std::string mode() { const char* s=getenv("MOCK_MODE"); return s?s:"ok"; }
fDisConnect disconnectCallback=nullptr;
fServiceCallBack registerCallback=nullptr;
LDWORD registerUser=0;
int downloads=0;
}
extern "C" {
BOOL CLIENT_Init(fDisConnect callback, LDWORD) { disconnectCallback=callback; return TRUE; }
void CLIENT_Cleanup() {}
DWORD CLIENT_GetLastError() { return 999; }
LLONG CLIENT_ListenServer(char*, WORD, int, fServiceCallBack callback, LDWORD user) {
    registerCallback=callback;registerUser=user;
    char ip[]="127.0.0.1", wrong[]="WRONG", right[]="101";
    callback(1,ip,37777,DH_DVR_SERIAL_RETURN,wrong,sizeof(wrong),user);
    // Unsupported binary/token notification must not be parsed as a string.
    unsigned char binary[]={0xff,0xfe,0xfd};
    callback(1,ip,37777,NET_DEV_AUTOREGISTER_RETURN,binary,sizeof(binary),user);
    callback(1,ip,37777,DH_DVR_SERIAL_RETURN,right,3,user); // length without trailing NUL
    return 1;
}
BOOL CLIENT_StopListenServer(LLONG) { return TRUE; }
LLONG CLIENT_LoginEx2(const char*, WORD, const char*, const char* password,
                     EM_LOGIN_SPAC_CAP_TYPE cap, void* id, NET_DEVICEINFO_Ex* info, int* error) {
    if(cap!=EM_LOGIN_SPEC_CAP_SERVER_CONN || strcmp(static_cast<char*>(id),"101") || strcmp(password,"mock-secret")) abort();
    if(mode()=="login-fail") { *error=7; return 0; }
    info->nChanNum=4; return 2;
}
BOOL CLIENT_Logout(LLONG) {
    if(mode()=="reconnect") {
        char ip[]="127.0.0.1",id[]="101";
        registerCallback(1,ip,37777,DH_DVR_SERIAL_RETURN,id,3,registerUser);
    }
    return TRUE;
}
LLONG CLIENT_DownloadByTimeEx(LLONG, int channel, int, NET_TIME*, NET_TIME*, char* path,
                              fTimeDownLoadPosCallBack callback, LDWORD user,
                              fDataCallBack, LDWORD, void*) {
    if(channel!=0) abort(); // UI channel 1 must map to SDK channel 0.
    FILE* f=fopen(path,"wb"); if(!f) abort();
    if(mode()!="empty") fwrite("MOCK_DAV",1,8,f);
    fclose(f); NET_RECORDFILE_INFO record{};
    ++downloads;
    if(mode()=="reconnect"&&downloads==1) {
        char ip[]="127.0.0.1";disconnectCallback(2,ip,37777,0);
        callback(3,8,static_cast<DWORD>(-2),0,record,user);
    } else callback(3,8,mode()=="incomplete"?static_cast<DWORD>(-2):static_cast<DWORD>(-1),0,record,user);
    return 3;
}
BOOL CLIENT_StopDownload(LLONG) { return TRUE; }
}
