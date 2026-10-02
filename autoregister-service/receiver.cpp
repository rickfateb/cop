#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstring>
#include <ctime>
#include <deque>
#include <dlfcn.h>
#include <filesystem>
#include <iostream>
#include <map>
#include <mutex>
#include <poll.h>
#include <regex>
#include <set>
#include <string>
#include <thread>
#include <unistd.h>
#include <vector>
#include "dhnetsdk.h"

namespace {
std::atomic<bool> cancelled{false};
std::atomic<int> progress{0};
std::atomic<LLONG> activeLogin{0};
std::atomic<LDWORD> generation{0};
std::mutex mutex;
std::condition_variable changed;
struct Endpoint { std::string ip; WORD port; };
std::set<std::string> allowedIds;
std::map<std::string,Endpoint> registrations;
std::set<LLONG> disconnected;
using Command=std::vector<std::string>;
std::deque<Command> commands;
void signalHandler(int) { cancelled=true; }
void onDisconnect(LLONG handle,char*,LONG,LDWORD) {
    std::lock_guard<std::mutex> lock(mutex);
    if(disconnected.size()<64) disconnected.insert(handle);
    if(activeLogin==handle) progress=-1;
    changed.notify_one();
}
int onRegister(LLONG,char* ip,WORD port,LONG event,void* param,DWORD length,LDWORD) {
    if(event!=DH_DVR_SERIAL_RETURN || !ip || !param || !length || length>128) return 0;
    std::string id(static_cast<char*>(param),strnlen(static_cast<char*>(param),length));
    std::lock_guard<std::mutex> lock(mutex);
    if(allowedIds.count(id)) { registrations[id]={ip,port}; changed.notify_one(); }
    return 0;
}
void onDownload(LLONG,DWORD,DWORD downloaded,int,NET_RECORDFILE_INFO,LDWORD user) {
    if(user!=generation.load()) return;
    if(downloaded==static_cast<DWORD>(-1)) progress=1;
    if(downloaded==static_cast<DWORD>(-2)) progress=-1;
}
std::string quote(const std::string& s) {
    std::string out="\"";
    for(unsigned char c:s) {
        if(c=='"' || c=='\\') { out+='\\'; out+=c; }
        else if(c<32) out+='?'; else out+=c;
    }
    return out+'"';
}
void emit(const std::string& event,const std::string& id="",const std::string& request="",const std::string& error="") {
    std::cout<<"{\"event\":"<<quote(event)<<",\"device_id\":"<<quote(id)<<",\"request_id\":"<<quote(request)<<",\"error\":"<<quote(error)<<"}"<<std::endl;
}
bool readExact(void* target,size_t count) {
    auto* p=static_cast<unsigned char*>(target); size_t offset=0;
    while(offset<count && !cancelled) {
        pollfd fd{STDIN_FILENO,POLLIN,0};
        int ready=poll(&fd,1,200);
        if(ready<0) { if(errno==EINTR) continue; return false; }
        if(!ready) continue;
        ssize_t size=read(STDIN_FILENO,p+offset,count-offset);
        if(size<=0) return false;
        offset+=static_cast<size_t>(size);
    }
    return offset==count;
}
bool readCommand(Command& command) {
    command.clear();
    // Nine fields, each framed by a 32-bit big-endian byte length. Never log input.
    for(int i=0;i<9;i++) {
        unsigned char header[4];
        if(!readExact(header,4)) return false;
        size_t length=(size_t(header[0])<<24)|(size_t(header[1])<<16)|(size_t(header[2])<<8)|header[3];
        if(length>4096) return false;
        std::string value(length,'\0');
        if(length && !readExact(value.data(),length)) return false;
        if(value.find('\0')!=std::string::npos) return false;
        command.push_back(std::move(value));
    }
    return true;
}
void reader() {
    Command command;
    while(!cancelled && readCommand(command)) {
        std::unique_lock<std::mutex> lock(mutex);
        if(commands.size()>=64) { cancelled=true; break; }
        commands.push_back(std::move(command)); changed.notify_one();
    }
    cancelled=true; changed.notify_one();
}
template<class T> T symbol(void* lib,const char* name) {
    void* result=dlsym(lib,name);
    if(!result) throw std::runtime_error(std::string("SDK_FUNCTION_MISSING: ")+name);
    return reinterpret_cast<T>(result);
}
NET_TIME parseTime(const std::string& text) {
    std::smatch m;
    if(!std::regex_match(text,m,std::regex("([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})"))) throw std::runtime_error("INVALID_TIME");
    NET_TIME t{}; t.dwYear=std::stoi(m[1]);t.dwMonth=std::stoi(m[2]);t.dwDay=std::stoi(m[3]);
    t.dwHour=std::stoi(m[4]);t.dwMinute=std::stoi(m[5]);t.dwSecond=std::stoi(m[6]);
    bool leap=t.dwYear%4==0&&(t.dwYear%100!=0||t.dwYear%400==0);
    unsigned days[]={0,31,unsigned(leap?29:28),31,30,31,30,31,31,30,31,30,31};
    if(t.dwYear<2000||t.dwYear>2100||t.dwMonth<1||t.dwMonth>12||t.dwDay<1||t.dwDay>days[t.dwMonth]||t.dwHour>23||t.dwMinute>59||t.dwSecond>59) throw std::runtime_error("INVALID_TIME");
    return t;
}
time_t seconds(const NET_TIME& t) {
    tm v{};v.tm_year=t.dwYear-1900;v.tm_mon=t.dwMonth-1;v.tm_mday=t.dwDay;v.tm_hour=t.dwHour;v.tm_min=t.dwMinute;v.tm_sec=t.dwSecond;
    return timegm(&v);
}
struct Device { std::string user,password; LLONG login=0; int channels=0; };
}
int main(int argc,char** argv) {
    if(argc!=5) { std::cerr<<"Usage: receiver SDK_SO BIND PORT OUTPUT_ROOT\n";return 2; }
    std::signal(SIGTERM,signalHandler);std::signal(SIGINT,signalHandler);
    void* library=nullptr; bool initialized=false;LLONG listener=0,download=0;
    decltype(&CLIENT_Cleanup) cleanup=nullptr;
    decltype(&CLIENT_StopListenServer) stopListen=nullptr;
    decltype(&CLIENT_StopDownload) stopDownload=nullptr;
    decltype(&CLIENT_Logout) logout=nullptr;
    std::map<std::string,Device> devices;
    std::thread input;
    int result=1;
    try {
        int port=std::stoi(argv[3]);if(port<1||port>65535) throw std::runtime_error("INVALID_PORT");
        auto root=std::filesystem::canonical(argv[4]);
        Command config;
        while(readCommand(config)) {
            if(config[0]=="start") break;
            if(config[0]!="config"||config[1].empty()||config[1].size()>128||config[2].empty()||config[2].size()>120||config[3].empty()||config[3].size()>128||devices.size()>=64||devices.count(config[1])) throw std::runtime_error("INVALID_CONFIG");
            devices.emplace(config[1],Device{config[2],config[3],0,0});allowedIds.insert(config[1]);
            std::fill(config[3].begin(),config[3].end(),'\0');
        }
        if(devices.empty()||config.empty()||config[0]!="start") throw std::runtime_error("NO_CONFIG");
        library=dlopen(argv[1],RTLD_NOW|RTLD_GLOBAL);
        if(!library) throw std::runtime_error("SDK_LOAD_FAILED");
        auto init=symbol<decltype(&CLIENT_Init)>(library,"CLIENT_Init");
        cleanup=symbol<decltype(cleanup)>(library,"CLIENT_Cleanup");
        auto listen=symbol<decltype(&CLIENT_ListenServer)>(library,"CLIENT_ListenServer");
        stopListen=symbol<decltype(stopListen)>(library,"CLIENT_StopListenServer");
        auto loginEx=symbol<decltype(&CLIENT_LoginEx2)>(library,"CLIENT_LoginEx2");
        logout=symbol<decltype(logout)>(library,"CLIENT_Logout");
        auto downloadTime=symbol<decltype(&CLIENT_DownloadByTimeEx)>(library,"CLIENT_DownloadByTimeEx");
        stopDownload=symbol<decltype(stopDownload)>(library,"CLIENT_StopDownload");
        if(!init(onDisconnect,0)) throw std::runtime_error("SDK_INIT_FAILED");
        initialized=true;
        listener=listen(argv[2],static_cast<WORD>(port),1000,onRegister,0);
        if(!listener) throw std::runtime_error("LISTEN_FAILED");
        emit("listening"); input=std::thread(reader);
        while(!cancelled) {
            std::map<std::string,Endpoint> endpoints;
            std::set<LLONG> lost; Command job;
            {
                std::unique_lock<std::mutex> lock(mutex);
                changed.wait_for(lock,std::chrono::milliseconds(200),[]{return cancelled||!registrations.empty()||!disconnected.empty()||!commands.empty();});
                endpoints.swap(registrations);lost.swap(disconnected);
                if(!commands.empty()) {job=std::move(commands.front());commands.pop_front();}
            }
            for(auto& item:devices) if(lost.count(item.second.login)) {
                logout(item.second.login);item.second.login=0;emit("offline",item.first);
            }
            for(auto& item:endpoints) {
                auto& d=devices.at(item.first);
                if(d.login) continue;
                NET_DEVICEINFO_Ex info{};int error=0;
                d.login=loginEx(item.second.ip.c_str(),item.second.port,d.user.c_str(),d.password.c_str(),EM_LOGIN_SPEC_CAP_SERVER_CONN,const_cast<char*>(item.first.c_str()),&info,&error);
                d.channels=info.nChanNum;
                emit(d.login?"online":"login_failed",item.first);
            }
            if(job.empty()) continue;
            const auto& request=job[1]; const auto& id=job[2];
            try {
                if(job[0]!="download") throw std::runtime_error("INVALID_COMMAND");
                auto found=devices.find(id);
                if(found==devices.end()||!found->second.login) throw std::runtime_error("DVR_OFFLINE");
                auto& d=found->second;
                int channel=std::stoi(job[3]);
                if(channel<1||channel>d.channels) throw std::runtime_error("INVALID_CHANNEL");
                auto start=parseTime(job[4]),end=parseTime(job[5]);
                auto duration=seconds(end)-seconds(start);
                if(duration<=0||duration>120) throw std::runtime_error("INVALID_INTERVAL");
                auto output=std::filesystem::weakly_canonical(job[6]);
                auto relative=output.lexically_relative(root);
                if(relative.empty()||*relative.begin()==".."||output.extension()!=".dav") throw std::runtime_error("INVALID_OUTPUT");
                auto partial=output.string()+".partial";
                if(std::filesystem::exists(output)||std::filesystem::exists(partial)) throw std::runtime_error("OUTPUT_EXISTS");
                progress=0;activeLogin=d.login;LDWORD current=++generation;
                download=downloadTime(d.login,channel-1,0,&start,&end,partial.data(),onDownload,current,nullptr,0,nullptr);
                if(!download) throw std::runtime_error("DOWNLOAD_START_FAILED");
                auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(180);
                while(!progress&&!cancelled&&std::chrono::steady_clock::now()<deadline) {
                    if(std::filesystem::exists(partial)&&std::filesystem::file_size(partial)>256ULL*1024*1024) {progress=-1;break;}
                    usleep(100000);
                }
                stopDownload(download);download=0;activeLogin=0;++generation;
                if(progress!=1||cancelled) throw std::runtime_error("DOWNLOAD_INCOMPLETE");
                {
                    std::lock_guard<std::mutex> lock(mutex);
                    if(disconnected.count(d.login)) throw std::runtime_error("DOWNLOAD_INCOMPLETE");
                }
                if(!std::filesystem::exists(partial)||!std::filesystem::file_size(partial)) throw std::runtime_error("EMPTY_DOWNLOAD");
                if(std::filesystem::file_size(partial)>256ULL*1024*1024) throw std::runtime_error("TOO_LARGE");
                std::filesystem::rename(partial,output);emit("download_complete",id,request);
            } catch(const std::exception& e) {
                if(download) {stopDownload(download);download=0;}
                activeLogin=0;++generation;emit("download_failed",id,request,e.what());
            }
        }
        result=0;
    } catch(const std::exception& e) {emit("fatal","","",e.what());}
    cancelled=true;
    if(input.joinable()) input.join();
    if(download&&stopDownload) stopDownload(download);
    for(auto& item:devices) {
        if(item.second.login&&logout) logout(item.second.login);
        std::fill(item.second.password.begin(),item.second.password.end(),'\0');
    }
    if(listener&&stopListen) stopListen(listener);
    if(initialized&&cleanup) cleanup();
    if(library) dlclose(library);
    return result;
}
